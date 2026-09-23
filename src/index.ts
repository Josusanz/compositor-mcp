#!/usr/bin/env node
/**
 * compositor-mcp — an MCP server that lets Claude (or any MCP client) read and edit
 * Compositor `.comp` projects: https://github.com/robbietilton/Compositor
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sharp from "sharp";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BLEND_MODES,
  CompError,
  SAMPLING,
  createProject,
  descendants,
  entries,
  findLayer,
  imageFileFor,
  imagePath,
  maskFileFor,
  newID,
  readManifest,
  removeAsset,
  writeManifest,
  type LayerRecord,
  type Manifest,
} from "./comp.js";
import { renderFlattened } from "./render.js";

const server = new McpServer({ name: "compositor-mcp", version: "0.1.2" });

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

function guard<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) {
  return async (...args: A): Promise<ToolResult> => {
    try {
      return await fn(...args);
    } catch (e) {
      const msg = e instanceof CompError ? e.message : `Error: ${(e as Error).message ?? e}`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  };
}

const pkgArg = z.string().describe("Path to the .comp project package (a directory ending in .comp)");
const layerArg = z.string().describe("Layer UUID or its exact name");

function summarize(m: Manifest) {
  return {
    width: m.width,
    height: m.height,
    resolution: m.resolution ?? 72,
    version: m.version,
    documentID: m.documentID,
    activeLayerID: m.activeLayerID ?? null,
    layerCount: m.layers.length,
    guides: m.guides?.length ?? 0,
  };
}

function describeLayer(e: { layer: LayerRecord; depth: number; visible: boolean; effectiveOpacity: number }) {
  const l = e.layer;
  const kind = l.isGroup ? "folder" : l.adjustment ? "adjustment" : l.text ? "text" : l.shape ? "shape" : "pixels";
  return {
    id: l.id,
    name: l.name,
    kind,
    depth: e.depth,
    parentID: l.parentID ?? null,
    visible: l.isVisible,
    effectivelyVisible: e.visible,
    opacity: l.opacity ?? 1,
    effectiveOpacity: Number(e.effectiveOpacity.toFixed(4)),
    blendMode: l.blendMode ?? "Normal",
    origin: l.transform.origin,
    size: l.transform.size,
    rotation: l.transform.rotation ?? 0,
    flipX: l.transform.flipX ?? false,
    flipY: l.transform.flipY ?? false,
    hasMask: !!l.maskFile,
    maskEnabled: l.maskFile ? l.maskEnabled !== false : false,
    clippedTo: l.maskSourceID ?? null,
    hasEffects: !!l.effects,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

server.registerTool(
  "inspect_project",
  {
    title: "Inspect project",
    description: "Reads a Compositor .comp project and returns the canvas info plus every layer in stacking order (bottom to top), with folder depth, visibility, opacity, blend mode and transform.",
    inputSchema: { path: pkgArg },
  },
  guard(async ({ path: pkg }) => {
    const m = await readManifest(pkg);
    return json({ ...summarize(m), layers: entries(m.layers).map(describeLayer) });
  }),
);

server.registerTool(
  "list_layers",
  {
    title: "List layers",
    description: "Compact list of layers (id, name, kind, visibility) from top to bottom as shown in Compositor's Layers panel.",
    inputSchema: { path: pkgArg },
  },
  guard(async ({ path: pkg }) => {
    const m = await readManifest(pkg);
    const lines = entries(m.layers)
      .reverse()
      .map((e) => {
        const l = e.layer;
        const kind = l.isGroup ? "📁" : l.adjustment ? "◐" : l.text ? "T" : "▣";
        return `${"  ".repeat(e.depth)}${kind} ${l.name}  [${l.id}]${l.isVisible ? "" : " (hidden)"}${l.opacity !== undefined && l.opacity !== 1 ? ` ${Math.round(l.opacity * 100)}%` : ""}${l.blendMode && l.blendMode !== "Normal" ? ` ${l.blendMode}` : ""}`;
      });
    return text(`${m.width}×${m.height} px, ${m.layers.length} layers\n\n${lines.join("\n") || "(no layers)"}`);
  }),
);

server.registerTool(
  "render_preview",
  {
    title: "Render preview",
    description: "Flattens the project and returns a PNG preview image so the model can see the composition. Optionally saves it to a file. Clipping masks, adjustment layers and layer effects are not rendered; the response lists what was skipped.",
    inputSchema: {
      path: pkgArg,
      maxSize: z.number().int().min(16).max(4096).default(1024).describe("Longest side of the preview in pixels"),
      outputPath: z.string().optional().describe("If given, also writes the preview (PNG or JPEG by extension) to this path"),
    },
  },
  guard(async ({ path: pkg, maxSize, outputPath }) => {
    const m = await readManifest(pkg);
    const r = await renderFlattened(pkg, m, { maxSize });
    const png = await r.image.png().toBuffer();
    if (outputPath) {
      const out = path.resolve(outputPath);
      const s = sharp(png);
      await (/\.jpe?g$/i.test(out) ? s.flatten({ background: "#ffffff" }).jpeg({ quality: 92 }) : s.png()).toFile(out);
    }
    const note = [`Preview ${r.width}×${r.height} of a ${m.width}×${m.height} canvas.`, ...r.warnings.map((w) => `Note: ${w}`)].join("\n");
    return { content: [{ type: "text", text: note }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
  }),
);

server.registerTool(
  "export_flattened",
  {
    title: "Export flattened image",
    description: "Renders the whole project at full resolution to a PNG or JPEG file.",
    inputSchema: {
      path: pkgArg,
      outputPath: z.string().describe("Destination file; .png keeps transparency, .jpg flattens onto white"),
      quality: z.number().int().min(1).max(100).default(92).describe("JPEG quality"),
    },
  },
  guard(async ({ path: pkg, outputPath, quality }) => {
    const m = await readManifest(pkg);
    const r = await renderFlattened(pkg, m);
    const out = path.resolve(outputPath);
    const jpeg = /\.jpe?g$/i.test(out);
    const img = jpeg ? r.image.flatten({ background: "#ffffff" }).jpeg({ quality }) : r.image.png();
    if (m.resolution) img.withMetadata({ density: m.resolution });
    await img.toFile(out);
    return text([`Wrote ${out} (${r.width}×${r.height})`, ...r.warnings.map((w) => `Note: ${w}`)].join("\n"));
  }),
);

server.registerTool(
  "export_layer",
  {
    title: "Export a layer's pixels",
    description: "Copies a pixel layer's source PNG (untransformed, original resolution) or its mask to a file.",
    inputSchema: {
      path: pkgArg,
      layer: layerArg,
      outputPath: z.string(),
      what: z.enum(["image", "mask"]).default("image"),
    },
  },
  guard(async ({ path: pkg, layer, outputPath, what }) => {
    const m = await readManifest(pkg);
    const l = findLayer(m, layer);
    const file = what === "mask" ? l.maskFile : l.imageFile;
    if (!file) throw new CompError(`Layer "${l.name}" has no ${what}`);
    const out = path.resolve(outputPath);
    await fs.copyFile(imagePath(pkg, file), out);
    return text(`Wrote ${out}`);
  }),
);

// ---------------------------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------------------------

server.registerTool(
  "create_project",
  {
    title: "Create project",
    description: "Creates a new empty .comp project. Optionally adds a solid background layer.",
    inputSchema: {
      path: pkgArg,
      width: z.number().int().min(1).max(30_000),
      height: z.number().int().min(1).max(30_000),
      resolution: z.number().min(1).max(9600).optional().describe("Pixels per inch (default 72)"),
      background: z.string().optional().describe("CSS color for a Background layer, e.g. #ffffff. Omit for a transparent document."),
    },
  },
  guard(async ({ path: pkg, width, height, resolution, background }) => {
    const m = await createProject(pkg, width, height, resolution);
    if (background) {
      const id = newID();
      await sharp({ create: { width, height, channels: 4, background } }).png().toFile(imagePath(pkg, imageFileFor(id)));
      m.layers.push({ id, name: "Background", isVisible: true, transform: { origin: [0, 0], size: [width, height] }, imageFile: imageFileFor(id) });
      m.activeLayerID = id;
      await writeManifest(pkg, m);
    }
    return json(summarize(m));
  }),
);

const placementArg = z
  .enum(["original", "fit", "fill", "stretch"])
  .default("original")
  .describe("original: 1:1 pixels centered; fit: scale to fit inside the canvas; fill: scale to cover the canvas; stretch: match canvas size");

const insertArgs = {
  parent: z.string().optional().describe("Folder (id or name) to put the layer in; omit for the root"),
  above: z.string().optional().describe("Place directly above this layer (id or name)"),
  below: z.string().optional().describe("Place directly below this layer (id or name)"),
};

/** Inserts `layer` into the manifest respecting parent/above/below; default is on top of its parent. */
function insertLayer(m: Manifest, layer: LayerRecord, opts: { parent?: string; above?: string; below?: string }) {
  if (opts.above && opts.below) throw new CompError("Give above or below, not both");
  const anchorRef = opts.above ?? opts.below;
  if (anchorRef) {
    const anchor = findLayer(m, anchorRef);
    layer.parentID = anchor.parentID;
    const idx = m.layers.indexOf(anchor);
    if (opts.above) {
      // Skip the anchor's subtree so we land right after it in bottom-to-top order.
      const sub = anchor.isGroup ? descendants(m, anchor.id) : [];
      m.layers.splice(idx + 1 + sub.length, 0, layer);
    } else {
      m.layers.splice(idx, 0, layer);
    }
    return;
  }
  if (opts.parent) {
    const p = findLayer(m, opts.parent);
    if (!p.isGroup) throw new CompError(`"${p.name}" is not a folder`);
    layer.parentID = p.id;
  }
  m.layers.push(layer);
}

server.registerTool(
  "add_image_layer",
  {
    title: "Add image layer",
    description: "Imports an image file (PNG, JPEG, HEIC, TIFF, WebP…) as a new pixel layer. The pixels are stored as-is; the placement only sets the layer's transform.",
    inputSchema: {
      path: pkgArg,
      imagePath: z.string().describe("Image file to import"),
      name: z.string().optional().describe("Layer name (defaults to the file name)"),
      placement: placementArg,
      origin: z.tuple([z.number(), z.number()]).optional().describe("Explicit top-left position in canvas pixels; overrides centering"),
      size: z.tuple([z.number(), z.number()]).optional().describe("Explicit display size in canvas pixels; overrides placement"),
      opacity: z.number().min(0).max(1).optional(),
      blendMode: z.enum(BLEND_MODES).optional(),
      ...insertArgs,
    },
  },
  guard(async ({ path: pkg, imagePath: src, name, placement, origin, size, opacity, blendMode, parent, above, below }) => {
    const m = await readManifest(pkg);
    const id = newID();
    const input = sharp(path.resolve(src), { limitInputPixels: 100_000_000 }).rotate(); // honor EXIF orientation
    const meta = await input.metadata();
    const iw = meta.width!;
    const ih = meta.height!;
    if (iw > 30_000 || ih > 30_000) throw new CompError("Image exceeds 30,000 px per side");
    await input.ensureAlpha().toColourspace("srgb").png({ compressionLevel: 6 }).toFile(imagePath(pkg, imageFileFor(id)));

    let w = iw;
    let h = ih;
    if (size) [w, h] = size;
    else if (placement === "stretch") [w, h] = [m.width, m.height];
    else if (placement === "fit" || placement === "fill") {
      const s = placement === "fit" ? Math.min(m.width / iw, m.height / ih) : Math.max(m.width / iw, m.height / ih);
      w = iw * s;
      h = ih * s;
    }
    const o: [number, number] = origin ?? [(m.width - w) / 2, (m.height - h) / 2];
    const layer: LayerRecord = {
      id,
      name: name ?? path.parse(src).name,
      isVisible: true,
      transform: { origin: o, size: [w, h] },
      imageFile: imageFileFor(id),
    };
    if (opacity !== undefined && opacity !== 1) layer.opacity = opacity;
    if (blendMode && blendMode !== "Normal") layer.blendMode = blendMode;
    insertLayer(m, layer, { parent, above, below });
    m.activeLayerID = id;
    await writeManifest(pkg, m);
    return json({ added: describeLayer(entries(m.layers).find((e) => e.layer.id === id)!), sourcePixels: [iw, ih] });
  }),
);

server.registerTool(
  "add_folder",
  {
    title: "Add folder",
    description: "Creates an empty layer folder (group).",
    inputSchema: { path: pkgArg, name: z.string(), ...insertArgs },
  },
  guard(async ({ path: pkg, name, parent, above, below }) => {
    const m = await readManifest(pkg);
    const layer: LayerRecord = {
      id: newID(),
      name,
      isVisible: true,
      isGroup: true,
      transform: { origin: [0, 0], size: [m.width, m.height] },
    };
    insertLayer(m, layer, { parent, above, below });
    await writeManifest(pkg, m);
    return json({ added: { id: layer.id, name } });
  }),
);

server.registerTool(
  "set_layer",
  {
    title: "Set layer properties",
    description: "Changes name, visibility, opacity, blend mode, mask enablement or transform (origin, size, rotation, flips) of a layer. Only the given fields change.",
    inputSchema: {
      path: pkgArg,
      layer: layerArg,
      name: z.string().optional(),
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(1).optional(),
      blendMode: z.enum(BLEND_MODES).optional(),
      maskEnabled: z.boolean().optional(),
      origin: z.tuple([z.number(), z.number()]).optional().describe("Top-left in canvas pixels"),
      size: z.tuple([z.number(), z.number()]).optional().describe("Display size in canvas pixels; source pixels are untouched"),
      rotation: z.number().optional().describe("Clockwise degrees"),
      flipX: z.boolean().optional(),
      flipY: z.boolean().optional(),
      sampling: z.enum(SAMPLING).optional(),
      active: z.boolean().optional().describe("Make it the selected layer in Compositor"),
    },
  },
  guard(async ({ path: pkg, layer, name, visible, opacity, blendMode, maskEnabled, origin, size, rotation, flipX, flipY, sampling, active }) => {
    const m = await readManifest(pkg);
    const l = findLayer(m, layer);
    if (name !== undefined) l.name = name;
    if (visible !== undefined) l.isVisible = visible;
    if (opacity !== undefined) l.opacity = opacity === 1 ? undefined : opacity;
    if (blendMode !== undefined) {
      if (l.isGroup && blendMode !== "Normal") throw new CompError("Folders keep the Normal blend mode");
      l.blendMode = blendMode === "Normal" ? undefined : blendMode;
    }
    if (maskEnabled !== undefined) {
      if (!l.maskFile) throw new CompError(`Layer "${l.name}" has no mask`);
      l.maskEnabled = maskEnabled;
    }
    if (origin) l.transform.origin = origin;
    if (size) l.transform.size = size;
    if (rotation !== undefined) l.transform.rotation = rotation === 0 ? undefined : rotation;
    if (flipX !== undefined) l.transform.flipX = flipX || undefined;
    if (flipY !== undefined) l.transform.flipY = flipY || undefined;
    if (sampling !== undefined) l.transform.sampling = sampling;
    if (active) m.activeLayerID = l.id;
    await writeManifest(pkg, m);
    return json(describeLayer(entries(m.layers).find((e) => e.layer.id === l.id)!));
  }),
);

server.registerTool(
  "move_layer",
  {
    title: "Move layer in the stack",
    description: "Reorders a layer (with its subtree if it is a folder): to the top or bottom of a folder or the root, or directly above/below another layer.",
    inputSchema: {
      path: pkgArg,
      layer: layerArg,
      to: z.enum(["top", "bottom"]).optional().describe("Top or bottom of the destination folder (or root)"),
      ...insertArgs,
    },
  },
  guard(async ({ path: pkg, layer, to, parent, above, below }) => {
    const m = await readManifest(pkg);
    const l = findLayer(m, layer);
    const subtree = [l, ...(l.isGroup ? descendants(m, l.id) : [])];
    const ids = new Set(subtree.map((s) => s.id));
    for (const ref of [parent, above, below]) {
      if (ref && ids.has(findLayer(m, ref).id)) throw new CompError("Cannot move a folder into itself");
    }
    m.layers = m.layers.filter((x) => !ids.has(x.id));
    if (above || below) {
      insertLayer(m, l, { above, below });
    } else {
      l.parentID = undefined;
      if (parent) {
        const p = findLayer(m, parent);
        if (!p.isGroup) throw new CompError(`"${p.name}" is not a folder`);
        l.parentID = p.id;
      }
      if (to === "bottom") {
        const first = m.layers.findIndex((x) => (x.parentID ?? undefined) === (l.parentID ?? undefined));
        m.layers.splice(first < 0 ? m.layers.length : first, 0, l);
      } else {
        m.layers.push(l);
      }
    }
    // Descendants keep their own parent links; normalizeOrder in writeManifest places them.
    m.layers.push(...subtree.slice(1));
    await writeManifest(pkg, m);
    const lines = entries(m.layers).reverse().map((e) => `${"  ".repeat(e.depth)}${e.layer.name}`);
    return text(`Moved "${l.name}". Stack (top to bottom):\n${lines.join("\n")}`);
  }),
);

server.registerTool(
  "remove_layer",
  {
    title: "Remove layer",
    description: "Deletes a layer (and, for a folder, everything inside it) together with its image and mask files.",
    inputSchema: { path: pkgArg, layer: layerArg },
  },
  guard(async ({ path: pkg, layer }) => {
    const m = await readManifest(pkg);
    const l = findLayer(m, layer);
    const gone = [l, ...(l.isGroup ? descendants(m, l.id) : [])];
    const ids = new Set(gone.map((g) => g.id));
    m.layers = m.layers.filter((x) => !ids.has(x.id));
    for (const x of m.layers) if (x.maskSourceID && ids.has(x.maskSourceID)) delete x.maskSourceID;
    if (m.activeLayerID && ids.has(m.activeLayerID)) m.activeLayerID = m.layers.at(-1)?.id;
    await writeManifest(pkg, m);
    for (const g of gone) {
      await removeAsset(pkg, g.imageFile);
      await removeAsset(pkg, g.maskFile);
    }
    return text(`Removed ${gone.map((g) => `"${g.name}"`).join(", ")}`);
  }),
);

server.registerTool(
  "replace_layer_image",
  {
    title: "Replace layer pixels",
    description: "Swaps the source pixels of a pixel layer with another image file, keeping its transform, mask and properties. Use it to round-trip a layer through an external editor or a generated image.",
    inputSchema: {
      path: pkgArg,
      layer: layerArg,
      imagePath: z.string(),
      keepDisplaySize: z.boolean().default(true).describe("true keeps the on-canvas size; false shows the new image 1:1"),
    },
  },
  guard(async ({ path: pkg, layer, imagePath: src, keepDisplaySize }) => {
    const m = await readManifest(pkg);
    const l = findLayer(m, layer);
    if (l.isGroup || l.adjustment) throw new CompError(`"${l.name}" has no pixels to replace`);
    const input = sharp(path.resolve(src), { limitInputPixels: 100_000_000 }).rotate();
    const meta = await input.metadata();
    await input.ensureAlpha().toColourspace("srgb").png({ compressionLevel: 6 }).toFile(imagePath(pkg, imageFileFor(l.id)));
    l.imageFile = imageFileFor(l.id);
    if (!keepDisplaySize) l.transform.size = [meta.width!, meta.height!];
    if (l.text) delete l.text; // pixels no longer match the editable text
    await writeManifest(pkg, m);
    return json(describeLayer(entries(m.layers).find((e) => e.layer.id === l.id)!));
  }),
);

server.registerTool(
  "set_layer_mask",
  {
    title: "Set or clear a layer mask",
    description: "Attaches a raster mask from a grayscale image (white reveals, black hides) to a layer, or removes the existing mask. The mask is stretched over the layer's own rectangle.",
    inputSchema: {
      path: pkgArg,
      layer: layerArg,
      maskPath: z.string().optional().describe("Grayscale or any image; luminance becomes coverage. Omit to clear the mask."),
      invert: z.boolean().default(false),
    },
  },
  guard(async ({ path: pkg, layer, maskPath, invert }) => {
    const m = await readManifest(pkg);
    const l = findLayer(m, layer);
    if (!maskPath) {
      await removeAsset(pkg, l.maskFile);
      delete l.maskFile;
      delete l.maskEnabled;
      delete l.maskPlacement;
      delete l.maskLinked;
      await writeManifest(pkg, m);
      return text(`Cleared the mask on "${l.name}"`);
    }
    let img = sharp(path.resolve(maskPath), { limitInputPixels: 100_000_000 }).rotate().flatten({ background: "#000000" }).toColourspace("b-w");
    if (invert) img = img.negate();
    await img.removeAlpha().png({ palette: false, compressionLevel: 6 }).toFile(imagePath(pkg, maskFileFor(l.id)));
    l.maskFile = maskFileFor(l.id);
    l.maskEnabled = true;
    await writeManifest(pkg, m);
    return text(`Mask set on "${l.name}"`);
  }),
);

server.registerTool(
  "resize_canvas",
  {
    title: "Resize canvas",
    description: "Changes the document size without resampling layers. Layers keep their pixels and are offset according to the anchor.",
    inputSchema: {
      path: pkgArg,
      width: z.number().int().min(1).max(30_000),
      height: z.number().int().min(1).max(30_000),
      anchor: z.enum(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]).default("center"),
    },
  },
  guard(async ({ path: pkg, width, height, anchor }) => {
    const m = await readManifest(pkg);
    const ax = anchor.includes("left") ? 0 : anchor.includes("right") ? 1 : 0.5;
    const ay = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 1 : 0.5;
    const dx = (width - m.width) * ax;
    const dy = (height - m.height) * ay;
    for (const l of m.layers) {
      l.transform.origin = [l.transform.origin[0] + dx, l.transform.origin[1] + dy];
    }
    m.width = width;
    m.height = height;
    await writeManifest(pkg, m);
    return json(summarize(m));
  }),
);

server.registerTool(
  "open_in_compositor",
  {
    title: "Open in Compositor",
    description: "Opens (or reloads) the project in the Compositor app on this Mac so the user can see the result. Compositor reads the package from disk on open.",
    inputSchema: { path: pkgArg },
  },
  guard(async ({ path: pkg }) => {
    if (process.platform !== "darwin") throw new CompError("Compositor only runs on macOS");
    const m = await readManifest(pkg);
    await promisify(execFile)("open", ["-b", "com.wonderassembly.compositor", path.resolve(pkg)]);
    return text(`Opened ${path.basename(pkg)} (${m.width}×${m.height}, ${m.layers.length} layers) in Compositor`);
  }),
);

// ---------------------------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------------------------

server.registerResource(
  "format",
  "compositor://format",
  { title: "Compositor .comp format notes", mimeType: "text/markdown" },
  async () => ({
    contents: [
      {
        uri: "compositor://format",
        mimeType: "text/markdown",
        text: `# Compositor .comp format (as understood by compositor-mcp)

A package directory with \`manifest.json\` and \`images/<LAYER-UUID>.png\` (8-bit PNG, sRGB) plus optional \`images/<LAYER-UUID>.mask.png\` (8-bit grayscale, no alpha; white reveals).

Manifest: format "com.compositor.project", version 1–9 (newer accepted and preserved), colorSpace "sRGB", width/height (1–30000), optional resolution (ppi), documentID, activeLayerID, layers (bottom to top), guides.

Layer: id (uppercase UUID), name, isVisible, transform {origin:[x,y], size:[w,h], rotation (cw degrees), flipX, flipY, sampling}, imageFile, parentID, isGroup, opacity (0–1), blendMode (${BLEND_MODES.join(", ")}), maskFile, maskEnabled, maskSourceID (clipping base), adjustment, effects, text, shape.

Transforms are non-destructive: the PNG holds the original pixels and \`size\` is the display size on the canvas. Folders are pass-through and always blend Normal. Upstream reference: docs/project-format.md in the Compositor repository.`,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
