/**
 * Reading and writing Compositor `.comp` packages.
 *
 * A `.comp` file is a directory containing `manifest.json` and an `images/` folder with one
 * 8-bit PNG per pixel layer (`<LAYER-UUID>.png`) and optional masks (`<LAYER-UUID>.mask.png`).
 * The schema mirrors `ProjectStore.swift` in the Compositor repository. Unknown fields are
 * preserved untouched so newer app versions keep working with this tool.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const FORMAT = "com.compositor.project";
/** The newest format version this tool understands and writes. Compositor 1.2.6 writes 9. */
export const MAX_VERSION = 9;
export const MAX_SIDE = 30_000;
export const MAX_PIXELS = 100_000_000;
export const MAX_LAYERS = 10_000;

export const BLEND_MODES = [
  "Normal",
  "Darken", "Multiply", "Color Burn", "Linear Burn",
  "Lighten", "Screen", "Color Dodge", "Linear Dodge (Add)",
  "Overlay", "Soft Light", "Hard Light", "Vivid Light", "Linear Light", "Pin Light", "Hard Mix",
  "Difference", "Exclusion", "Subtract", "Divide",
  "Hue", "Saturation", "Color", "Luminosity",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const SAMPLING = ["Nearest", "Smooth", "High quality"] as const;
export type Sampling = (typeof SAMPLING)[number];

export interface Transform {
  origin: [number, number];
  size: [number, number];
  rotation?: number; // clockwise degrees
  flipX?: boolean;
  flipY?: boolean;
  sampling?: Sampling;
}

export interface LayerRecord {
  id: string;
  name: string;
  isVisible: boolean;
  transform: Transform;
  imageFile?: string | null;
  parentID?: string;
  isGroup?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  maskFile?: string;
  maskEnabled?: boolean;
  maskSourceID?: string;
  adjustment?: unknown;
  effects?: unknown;
  text?: unknown;
  shape?: unknown;
  [extra: string]: unknown;
}

export interface Manifest {
  format: string;
  version: number;
  colorSpace: string;
  resolution?: number;
  documentID: string;
  width: number;
  height: number;
  activeLayerID?: string;
  layers: LayerRecord[];
  guides?: unknown[];
  [extra: string]: unknown;
}

export class CompError extends Error {}

export function newID(): string {
  return randomUUID().toUpperCase();
}

export function imageFileFor(id: string): string {
  return `${id}.png`;
}
export function maskFileFor(id: string): string {
  return `${id}.mask.png`;
}

export function resolvePackagePath(p: string): string {
  const abs = path.resolve(p);
  if (!abs.toLowerCase().endsWith(".comp")) throw new CompError(`Not a .comp package path: ${p}`);
  return abs;
}

export async function readManifest(pkg: string): Promise<Manifest> {
  const dir = resolvePackagePath(pkg);
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new CompError(`Project not found: ${dir}`);
  }
  if (!stat.isDirectory()) throw new CompError(`Not a package directory: ${dir}`);
  const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new CompError("manifest.json is not valid JSON");
  }
  if (manifest.format !== FORMAT) throw new CompError(`Unknown format: ${manifest.format}`);
  if (typeof manifest.version !== "number" || !Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new CompError(`Unsupported project version ${manifest.version} (this tool knows 1–${MAX_VERSION})`);
  }
  // Newer versions are accepted: fields this tool does not understand are preserved on round trip and the
  // file keeps its own version number, so the app that wrote it can still open it.
  if (!Array.isArray(manifest.layers)) throw new CompError("manifest.layers missing");
  return manifest;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** Validates and writes the manifest atomically (temp file + rename), like Compositor does. */
export async function writeManifest(pkg: string, manifest: Manifest): Promise<void> {
  const dir = resolvePackagePath(pkg);
  manifest.version = Math.max(manifest.version, MAX_VERSION);
  manifest.layers = normalizeOrder(manifest.layers);
  for (const l of manifest.layers) l.transform = fullTransform(l.transform);
  validate(manifest);
  await fs.mkdir(path.join(dir, "images"), { recursive: true });
  const data = JSON.stringify(sortKeysDeep(manifest), null, 2) + "\n";
  if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new CompError("Manifest exceeds 4 MiB");
  const tmp = path.join(dir, `.manifest.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, path.join(dir, "manifest.json"));
}

export async function createProject(
  pkg: string,
  width: number,
  height: number,
  resolution?: number,
): Promise<Manifest> {
  const dir = resolvePackagePath(pkg);
  try {
    await fs.access(dir);
    throw new CompError(`Already exists: ${dir}`);
  } catch (e) {
    if (e instanceof CompError) throw e;
  }
  await fs.mkdir(path.join(dir, "images"), { recursive: true });
  const manifest: Manifest = {
    format: FORMAT,
    version: MAX_VERSION,
    colorSpace: "sRGB",
    documentID: newID(),
    width,
    height,
    layers: [],
  };
  if (resolution !== undefined) manifest.resolution = resolution;
  await writeManifest(dir, manifest);
  return manifest;
}

/**
 * Swift's synthesized Decodable requires every non-optional key even when the property has a
 * default, so a transform must always carry rotation, flipX, flipY and sampling.
 */
export function fullTransform(t: Transform): Transform {
  return {
    origin: t.origin,
    size: t.size,
    rotation: t.rotation ?? 0,
    flipX: t.flipX ?? false,
    flipY: t.flipY ?? false,
    sampling: t.sampling ?? "High quality",
  };
}

/** Re-emits layers in traversal order (bottom to top, each folder followed by its subtree). */
export function normalizeOrder(layers: LayerRecord[]): LayerRecord[] {
  const byParent = new Map<string | undefined, LayerRecord[]>();
  for (const l of layers) {
    const key = l.parentID ?? undefined;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(l);
  }
  const out: LayerRecord[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | undefined, depth: number) => {
    if (depth > 64) return;
    for (const l of byParent.get(parent) ?? []) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
      if (l.isGroup) visit(l.id, depth + 1);
    }
  };
  visit(undefined, 0);
  // Orphans (parent missing) come last so validation can report them.
  for (const l of layers) if (!seen.has(l.id)) out.push(l);
  return out;
}

export interface Entry {
  layer: LayerRecord;
  depth: number;
  visible: boolean;
  effectiveOpacity: number;
}

/** Layers in render order with inherited visibility and opacity, like `LayerHierarchy.entries`. */
export function entries(layers: LayerRecord[]): Entry[] {
  const byParent = new Map<string | undefined, LayerRecord[]>();
  for (const l of layers) {
    const key = l.parentID ?? undefined;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(l);
  }
  const out: Entry[] = [];
  const visit = (parent: string | undefined, depth: number, visible: boolean, opacity: number) => {
    if (depth > 64) return;
    for (const l of byParent.get(parent) ?? []) {
      const v = visible && l.isVisible;
      const o = opacity * (l.opacity ?? 1);
      out.push({ layer: l, depth, visible: v, effectiveOpacity: o });
      if (l.isGroup) visit(l.id, depth + 1, v, o);
    }
  };
  visit(undefined, 0, true, 1);
  return out;
}

export function validate(m: Manifest): void {
  const bad = (msg: string): never => {
    throw new CompError(`Invalid project: ${msg}`);
  };
  if (m.format !== FORMAT) bad("format");
  if (m.colorSpace !== "sRGB") bad("colorSpace must be sRGB");
  if (m.resolution !== undefined && !(Number.isFinite(m.resolution) && m.resolution >= 1 && m.resolution <= 9600)) {
    bad("resolution must be 1–9600 pixels/inch");
  }
  if (!Number.isInteger(m.width) || !Number.isInteger(m.height) || m.width < 1 || m.height < 1 || m.width > MAX_SIDE || m.height > MAX_SIDE) {
    bad(`canvas must be 1–${MAX_SIDE} pixels per side`);
  }
  if (m.layers.length > MAX_LAYERS) bad(`more than ${MAX_LAYERS} layers`);
  const byID = new Map<string, LayerRecord>();
  for (const l of m.layers) {
    if (byID.has(l.id)) bad(`duplicate layer id ${l.id}`);
    byID.set(l.id, l);
    if (!l.name || !l.name.trim()) bad(`layer ${l.id} has an empty name`);
    if (Buffer.byteLength(l.name) > 16_384) bad("layer name too long");
    if (typeof l.isVisible !== "boolean") bad(`layer ${l.name}: isVisible missing`);
    const t = l.transform;
    if (!t || !Array.isArray(t.origin) || !Array.isArray(t.size)) bad(`layer ${l.name}: transform missing`);
    const nums = [t.origin[0], t.origin[1], t.size[0], t.size[1], t.rotation ?? 0];
    if (!nums.every(Number.isFinite)) bad(`layer ${l.name}: transform has non-finite values`);
    if (t.size[0] < 1 || t.size[0] > 300_000 || t.size[1] < 1 || t.size[1] > 300_000) bad(`layer ${l.name}: size out of range`);
    if (Math.abs(t.origin[0]) > 1_000_000 || Math.abs(t.origin[1]) > 1_000_000) bad(`layer ${l.name}: origin out of range`);
    if (t.sampling !== undefined && !SAMPLING.includes(t.sampling)) bad(`layer ${l.name}: unknown sampling`);
    if (l.imageFile != null && l.imageFile !== imageFileFor(l.id)) bad(`layer ${l.name}: imageFile must be ${imageFileFor(l.id)}`);
    if (l.isGroup && l.imageFile) bad(`folder ${l.name} cannot carry an image`);
    if (l.maskFile !== undefined && l.maskFile !== maskFileFor(l.id)) bad(`layer ${l.name}: maskFile must be ${maskFileFor(l.id)}`);
    if (l.maskEnabled !== undefined && l.maskFile === undefined) bad(`layer ${l.name}: maskEnabled without a mask`);
    const opacity = l.opacity ?? 1;
    if (!(Number.isFinite(opacity) && opacity >= 0 && opacity <= 1)) bad(`layer ${l.name}: opacity must be 0–1`);
    const blend = l.blendMode ?? "Normal";
    if (!BLEND_MODES.includes(blend)) bad(`layer ${l.name}: unknown blend mode ${blend}`);
    if (l.isGroup && blend !== "Normal") bad(`folder ${l.name}: blend mode must be Normal`);
    if (l.adjustment != null && (l.isGroup || l.imageFile)) bad(`adjustment layer ${l.name} cannot be a folder or carry pixels`);
    if (l.text != null && (l.isGroup || !l.imageFile)) bad(`text layer ${l.name} needs its rasterized image`);
  }
  for (const l of m.layers) {
    const seen = new Set<string>([l.id]);
    let parent = l.parentID;
    while (parent) {
      if (seen.size > 64) bad("nesting deeper than 64");
      if (seen.has(parent)) bad(`cycle through ${l.name}`);
      seen.add(parent);
      const node = byID.get(parent);
      if (!node) bad(`layer ${l.name}: parent ${parent} not found`);
      if (!node!.isGroup) bad(`layer ${l.name}: parent ${node!.name} is not a folder`);
      parent = node!.parentID;
    }
    if (l.maskSourceID !== undefined) {
      const src = byID.get(l.maskSourceID);
      if (!src) bad(`layer ${l.name}: clipping base ${l.maskSourceID} not found`);
      if (src!.isGroup) bad(`layer ${l.name}: clipping base cannot be a folder`);
      if (src!.id === l.id) bad(`layer ${l.name}: clipped to itself`);
    }
  }
  if (m.activeLayerID !== undefined && !byID.has(m.activeLayerID)) bad("activeLayerID not found");
  if (m.guides !== undefined && m.guides.length > 1000) bad("more than 1000 guides");
}

/** Finds a layer by UUID or by exact name (case-insensitive if unique). */
export function findLayer(m: Manifest, ref: string): LayerRecord {
  const byID = m.layers.find((l) => l.id.toUpperCase() === ref.toUpperCase());
  if (byID) return byID;
  const exact = m.layers.filter((l) => l.name === ref);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new CompError(`Several layers are named "${ref}"; use the id`);
  const loose = m.layers.filter((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new CompError(`Several layers match "${ref}"; use the id`);
  throw new CompError(`No layer named or identified by "${ref}"`);
}

export function descendants(m: Manifest, id: string): LayerRecord[] {
  const out: LayerRecord[] = [];
  const visit = (parent: string) => {
    for (const l of m.layers) if (l.parentID === parent) {
      out.push(l);
      if (l.isGroup) visit(l.id);
    }
  };
  visit(id);
  return out;
}

export function imagePath(pkg: string, file: string): string {
  return path.join(resolvePackagePath(pkg), "images", file);
}

export async function removeAsset(pkg: string, file: string | null | undefined): Promise<void> {
  if (!file) return;
  await fs.rm(imagePath(pkg, file), { force: true });
}
