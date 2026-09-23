import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createProject, entries, findLayer, imageFileFor, imagePath, newID, readManifest, validate, writeManifest } from "../src/comp.js";
import { renderFlattened } from "../src/render.js";

async function tmpProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-mcp-"));
  const pkg = path.join(dir, "test.comp");
  await createProject(pkg, 200, 100, 72);
  return pkg;
}

async function addSolid(pkg: string, name: string, color: string, w: number, h: number, x = 0, y = 0, extra: object = {}) {
  const m = await readManifest(pkg);
  const id = newID();
  await sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toFile(imagePath(pkg, imageFileFor(id)));
  m.layers.push({ id, name, isVisible: true, transform: { origin: [x, y], size: [w, h] }, imageFile: imageFileFor(id), ...extra });
  await writeManifest(pkg, m);
  return id;
}

test("creates a manifest Compositor accepts", async () => {
  const pkg = await tmpProject();
  const m = await readManifest(pkg);
  assert.equal(m.format, "com.compositor.project");
  assert.equal(m.version, 9);
  assert.equal(m.colorSpace, "sRGB");
  assert.match(m.documentID, /^[0-9A-F-]{36}$/);
  const raw = JSON.parse(await fs.readFile(path.join(pkg, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(raw), Object.keys(raw).slice().sort(), "keys are sorted like Swift's encoder");
});

test("transforms always carry every key Swift's decoder requires", async () => {
  const pkg = await tmpProject();
  await addSolid(pkg, "a", "#000000", 4, 4);
  const raw = JSON.parse(await fs.readFile(path.join(pkg, "manifest.json"), "utf8"));
  assert.deepEqual(raw.layers[0].transform, { flipX: false, flipY: false, origin: [0, 0], rotation: 0, sampling: "High quality", size: [4, 4] });
});

test("validation rejects what ProjectStore rejects", async () => {
  const pkg = await tmpProject();
  const m = await readManifest(pkg);
  const id = newID();
  m.layers.push({ id, name: "x", isVisible: true, transform: { origin: [0, 0], size: [10, 10] }, imageFile: "wrong.png" });
  assert.throws(() => validate(m), /imageFile must be/);
  m.layers[0].imageFile = imageFileFor(id);
  m.layers[0].opacity = 1.5;
  assert.throws(() => validate(m), /opacity/);
  m.layers[0].opacity = 0.5;
  m.layers[0].parentID = "MISSING";
  assert.throws(() => validate(m), /parent .* not found/);
  delete m.layers[0].parentID;
  validate(m);
});

test("preserves unknown fields on round trip", async () => {
  const pkg = await tmpProject();
  const m = await readManifest(pkg);
  (m as Record<string, unknown>).futureField = { a: 1 };
  await writeManifest(pkg, m);
  const again = await readManifest(pkg);
  assert.deepEqual((again as Record<string, unknown>).futureField, { a: 1 });
});

test("folder order and inherited opacity", async () => {
  const pkg = await tmpProject();
  const m = await readManifest(pkg);
  const folder = newID();
  const child = newID();
  m.layers.push({ id: folder, name: "F", isVisible: true, isGroup: true, opacity: 0.5, transform: { origin: [0, 0], size: [200, 100] } });
  m.layers.push({ id: child, name: "C", isVisible: true, opacity: 0.5, parentID: folder, transform: { origin: [0, 0], size: [10, 10] } });
  await writeManifest(pkg, m);
  const e = entries((await readManifest(pkg)).layers);
  assert.ok(e[1]);
  assert.deepEqual(e.map((x) => x.layer.name), ["F", "C"]);
  assert.equal(e[1]!.effectiveOpacity, 0.25);
  assert.equal(findLayer(m, "c").id, child);
});

test("renders layers with placement, opacity and blend", async () => {
  const pkg = await tmpProject();
  await addSolid(pkg, "bg", "#ffffff", 200, 100);
  await addSolid(pkg, "red", "#ff0000", 50, 50, 10, 10);
  await addSolid(pkg, "half-blue", "#0000ff", 50, 50, 100, 10, { opacity: 0.5 });
  await addSolid(pkg, "mult", "#00ff00", 20, 20, 150, 60, { blendMode: "Multiply" });
  const m = await readManifest(pkg);
  const r = await renderFlattened(pkg, m);
  const raw = await r.image.raw().toBuffer();
  const px = (x: number, y: number) => Array.from(raw.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4));
  assert.deepEqual(px(0, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(20, 20), [255, 0, 0, 255]);
  const b = px(120, 20) as number[];
  assert.ok(b[0]! > 120 && b[0]! < 135 && b[2] === 255, `half blue over white: ${b}`);
  assert.deepEqual(px(160, 70), [0, 255, 0, 255], "green multiplied over white stays green");
  assert.equal(r.warnings.length, 0);
});

test("layers off canvas do not break rendering", async () => {
  const pkg = await tmpProject();
  await addSolid(pkg, "big", "#123456", 400, 400, -150, -150);
  await addSolid(pkg, "gone", "#ff0000", 10, 10, 500, 500);
  const m = await readManifest(pkg);
  const r = await renderFlattened(pkg, m);
  const raw = await r.image.raw().toBuffer();
  assert.deepEqual(Array.from(raw.subarray(0, 4)), [0x12, 0x34, 0x56, 255]);
});
