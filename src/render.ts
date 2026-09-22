/**
 * Flattens a `.comp` project to a single image with sharp.
 *
 * Supported: layer order, folders, visibility, opacity (own and inherited), scale, rotation,
 * flips, raster masks, and the blend modes sharp implements. Not supported yet: clipping masks
 * (`maskSourceID`), adjustment layers, layer effects, folder masks. Those are reported as
 * warnings so the caller knows the preview differs from Compositor's own render.
 */
import sharp, { type Blend, type OverlayOptions, type Sharp } from "sharp";
import { entries, imagePath, type BlendMode, type Manifest } from "./comp.js";

const BLEND_TO_SHARP: Partial<Record<BlendMode, Blend>> = {
  Normal: "over",
  Darken: "darken",
  Multiply: "multiply",
  "Color Burn": "colour-burn",
  Lighten: "lighten",
  Screen: "screen",
  "Color Dodge": "colour-dodge",
  "Linear Dodge (Add)": "add",
  Overlay: "overlay",
  "Soft Light": "soft-light",
  "Hard Light": "hard-light",
  Difference: "difference",
  Exclusion: "exclusion",
};

export interface RenderOptions {
  maxSize?: number; // longest side of the output; the full canvas is used when omitted
}

export interface RenderResult {
  image: Sharp;
  width: number;
  height: number;
  warnings: string[];
}

export async function renderFlattened(pkg: string, m: Manifest, opts: RenderOptions = {}): Promise<RenderResult> {
  const warnings: string[] = [];
  const W = m.width;
  const H = m.height;
  const layers: OverlayOptions[] = [];

  for (const e of entries(m.layers)) {
    const l = e.layer;
    if (!e.visible || l.isGroup) continue;
    if (l.adjustment) { warnings.push(`Adjustment layer "${l.name}" was skipped`); continue; }
    if (!l.imageFile) continue;
    if (l.maskSourceID) warnings.push(`Clipping mask on "${l.name}" was ignored`);
    if (l.effects) warnings.push(`Layer effects on "${l.name}" were ignored`);

    const t = l.transform;
    const w = Math.max(1, Math.round(t.size[0]));
    const h = Math.max(1, Math.round(t.size[1]));
    let img = sharp(imagePath(pkg, l.imageFile)).ensureAlpha().resize(w, h, { fit: "fill", kernel: t.sampling === "Nearest" ? "nearest" : "lanczos3" });
    if (t.flipX) img = img.flop();
    if (t.flipY) img = img.flip();

    // Raster mask: multiply into alpha at layer resolution.
    if (l.maskFile && l.maskEnabled !== false) {
      const mask = await sharp(imagePath(pkg, l.maskFile)).resize(w, h, { fit: "fill" }).toColourspace("b-w").raw().toBuffer();
      const rgba = await img.raw().toBuffer();
      for (let i = 0, p = 3; i < mask.length; i++, p += 4) rgba[p] = (rgba[p] * mask[i]) / 255;
      img = sharp(rgba, { raw: { width: w, height: h, channels: 4 } });
    }

    // Opacity: scale alpha.
    const opacity = Math.max(0, Math.min(1, e.effectiveOpacity));
    if (opacity < 1) {
      const rgba = await img.raw().toBuffer();
      for (let p = 3; p < rgba.length; p += 4) rgba[p] = rgba[p] * opacity;
      img = sharp(rgba, { raw: { width: w, height: h, channels: 4 } });
    }

    // Rotation around the center, then position so the centers coincide.
    const rotation = ((t.rotation ?? 0) % 360 + 360) % 360;
    const cx = t.origin[0] + t.size[0] / 2;
    const cy = t.origin[1] + t.size[1] / 2;
    let buf = await img.png().toBuffer();
    let bw = w;
    let bh = h;
    if (rotation !== 0) {
      const rotated = sharp(buf).rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
      buf = await rotated.png().toBuffer();
      const meta = await sharp(buf).metadata();
      bw = meta.width!;
      bh = meta.height!;
    }
    let left = Math.round(cx - bw / 2);
    let top = Math.round(cy - bh / 2);

    // Crop to the canvas: sharp requires overlays to fit inside the base image.
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(W, left + bw);
    const y1 = Math.min(H, top + bh);
    if (x1 <= x0 || y1 <= y0) continue;
    if (x0 !== left || y0 !== top || x1 - x0 !== bw || y1 - y0 !== bh) {
      buf = await sharp(buf).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
      left = x0;
      top = y0;
    }

    const blendName = l.blendMode ?? "Normal";
    let blend = BLEND_TO_SHARP[blendName];
    if (!blend) {
      warnings.push(`Blend mode "${blendName}" on "${l.name}" is not supported by the preview; used Normal`);
      blend = "over";
    }
    layers.push({ input: buf, left, top, blend });
  }

  let image = sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers);
  let width = W;
  let height = H;
  if (opts.maxSize && Math.max(W, H) > opts.maxSize) {
    const scale = opts.maxSize / Math.max(W, H);
    width = Math.max(1, Math.round(W * scale));
    height = Math.max(1, Math.round(H * scale));
    image = sharp(await image.png().toBuffer()).resize(width, height);
  }
  return { image, width, height, warnings: [...new Set(warnings)] };
}
