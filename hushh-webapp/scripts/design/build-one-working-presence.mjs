// SPDX-License-Identifier: Apache-2.0
// Package authored typing poses into the existing native Rive Solo timeline.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = path.join(root, "public/one-presence");
const source = path.join(root, "assets/one-presence/working-keyframes.png");
export async function buildWorkingPresence({ check = false } = {}) {
  const size = 128;
  const sha = value => crypto.createHash("sha256").update(value).digest("hex");
  const u = number => {
    const result = [];
    do { const byte = number & 127; number >>>= 7; result.push(byte | (number ? 128 : 0)); } while (number);
    return Buffer.from(result);
  };
  const float = value => { const result = Buffer.alloc(4); result.writeFloatLE(value); return result; };
  const bytes = value => Buffer.concat([u(value.length), value]);
  const strings = new Set([4, 55, 203]);
  const floats = new Set([7, 8, 13, 14, 16, 17, 207, 208]);
  const record = (type, properties = {}) => Buffer.concat([
    u(type), ...Object.entries(properties).flatMap(([key, value]) => [u(Number(key)),
      Number(key) === 212 ? bytes(value) : strings.has(Number(key)) ? bytes(Buffer.from(value))
        : floats.has(Number(key)) ? float(value) : u(value)]), u(0),
  ]);
  const write = async (file, value) => {
    const destination = path.join(target, file);
    if (check) {
      if (!(await fs.readFile(destination)).equals(value)) throw Error(`Stale working asset: ${file}`);
    } else await fs.writeFile(destination, value);
  };

  const sourceBytes = await fs.readFile(source);
  const metadata = await sharp(sourceBytes).metadata();
  if (!metadata.hasAlpha || metadata.width !== metadata.height) throw Error("Expected square transparent 4x4 keyframes");
  // Round shared cell edges: the authored 1254px source is not divisible by four.
  const cells = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const left = Math.round(index % 4 * metadata.width / 4);
    const top = Math.round(Math.floor(index / 4) * metadata.height / 4);
    return sharp(sourceBytes).extract({ left, top,
      width: Math.round((index % 4 + 1) * metadata.width / 4) - left,
      height: Math.round((Math.floor(index / 4) + 1) * metadata.height / 4) - top,
    }).resize(314, 314).ensureAlpha().raw().toBuffer();
  }));
  // One union crop and one registration for every pose. Per-pose trim/resize
  // would make the head, laptop and feet change scale during hand movement.
  let left = 314, top = 314, right = 0, bottom = 0;
  for (const cell of cells) for (let y = 0; y < 314; y++) for (let x = 0; x < 314; x++) {
    if (cell[(y * 314 + x) * 4 + 3] < 32) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right <= left || bottom <= top) throw Error("Keyframe artwork is empty");
  const renderPoses = async textureSize => Promise.all(cells.map(async cell => {
    const image = await sharp(cell, { raw: { width: 314, height: 314, channels: 4 } })
      .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
      .resize({ width: Math.round(102 * textureSize / size), height: Math.round(94 * textureSize / size), fit: "inside" }).png().toBuffer();
    const bounds = await sharp(image).metadata();
    return sharp({ create: { width: textureSize, height: textureSize, channels: 4, background: "#00000000" } })
      .composite([{ input: image, left: Math.floor((textureSize - bounds.width) / 2), top: Math.round(114 * textureSize / size) - bounds.height }])
      .raw().toBuffer();
  }));
  const poses = await renderPoses(size);

  // Two cycles of two typing bursts, followed by one short blink. Two-frame
  // exposures give clear 12fps hand gestures inside the existing 24fps timeline.
  const cycle = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 0];
  const sequence = [...cycle, ...cycle, 13, 14, 14, 15].flatMap(index => [index, index]);
  const unique = [];
  const indices = [];
  const known = new Map();
  for (const index of sequence) {
    const pixels = Buffer.from(poses[index]);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] === 0) pixels.fill(0, offset, offset + 3);
    }
    const hash = sha(pixels);
    if (!known.has(hash)) {
      known.set(hash, unique.length);
      unique.push(await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
    }
    indices.push(known.get(hash));
  }
  if (sequence.length !== 72 || unique.length < 12) throw Error("Typing needs 72 timeline frames and distinct hand poses");
  const atlas = await sharp({ create: { width: size * 9, height: size * 8, channels: 4, background: "#00000000" } })
    .composite(indices.map((index, frame) => ({ input: unique[index], left: frame % 9 * size, top: Math.floor(frame / 9) * size })))
    .webp({ lossless: true, effort: 6 }).toBuffer();
  // Embed the decoded atlas pixels, as the original exports did. WebP's alpha
  // handling can canonicalize near-transparent RGB even in lossless mode.
  for (let index = 0; index < unique.length; index++) {
    const frame = indices.indexOf(index);
    unique[index] = await sharp(atlas).extract({ left: frame % 9 * size,
      top: Math.floor(frame / 9) * size, width: size, height: size }).png().toBuffer();
  }
  const serialize = (name, textureSize, images, selections) => {
  const records = [record(23)];
  images.forEach((png, index) => records.push(
    record(105, { 203: `working-pose-${index}`, 204: index + 1, 207: textureSize, 208: textureSize }),
    record(106, { 212: png }),
  ));
  records.push(record(1, { 4: name, 7: size, 8: size, 236: 0 }),
    record(147, { 4: "Frames", 5: 0, 296: 2 }));
  images.forEach((_, index) => records.push(record(100, { 4: `Pose ${index}`, 5: 1, 13: 64, 14: 64, 16: size / textureSize, 17: size / textureSize, 206: index })));
  records.push(record(31, { 55: name, 56: 24, 57: 72, 59: 1 }),
    record(25, { 51: 1 }), record(26, { 53: 296 }));
  selections.forEach((index, frame) => {
    if (frame === 0 || index !== selections[frame - 1]) records.push(record(50, { 67: frame, 68: 0, 122: index + 2 }));
  });
  records.push(record(50, { 67: 72, 68: 0, 122: selections[0] + 2 }),
    record(53, { 55: "State Machine 1" }), record(57, { 55: "Layer 1" }),
    record(63), record(65, { 151: 3, 158: 0 }), record(62), record(64), record(61, { 149: 0 }));
  return Buffer.concat([Buffer.from("RIVE"), u(7), u(4), u(0), u(0), ...records]);
  };
  const riv = serialize("Working", size, unique, indices);
  await write("working.riv", riv);
  await write("working.webp", atlas);
  const manifest = JSON.parse(await fs.readFile(path.join(target, "rive-manifest.json"), "utf8"));
  manifest["working.riv"] = { bytes: riv.length, sha256: sha(riv) };
  await write("rive-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  await write("working-animation.json", Buffer.from(`${JSON.stringify({
    source: "assets/one-presence/working-keyframes.png", source_sha256: sha(sourceBytes),
    grid: [4, 4], artboard: size, fps: 24, timeline_frames: sequence.length,
    unique_poses: unique.length, pose_sequence: sequence,
  }, null, 2)}\n`));
  console.log(`Working typing loop ${check ? "verified" : "built"}: ${unique.length} poses, 72 frames, ${riv.length} bytes.`);
  const hdSize = 314;
  const hdPoses = await renderPoses(hdSize);
  const hdImages = await Promise.all(hdPoses.map(pixels => sharp(pixels,
    { raw: { width: hdSize, height: hdSize, channels: 4 } }).png().toBuffer()));
  const hdRiv = serialize("working-hd", hdSize, hdImages, sequence);
  await write("hd/working.riv", hdRiv);
  await write("hd/working-poses.png", await sharp({ create: {
    width: hdSize * 4, height: hdSize * 4, channels: 4, background: "#00000000",
  } }).composite(hdImages.map((input, index) => ({ input, left: index % 4 * hdSize,
    top: Math.floor(index / 4) * hdSize }))).png().toBuffer());
  return { bytes: hdRiv.length, sha256: sha(hdRiv), source: "../../assets/one-presence/working-keyframes.png",
    source_sha256: sha(sourceBytes), texture_width: hdSize, texture_height: hdSize,
    textures: hdImages.length, artboard: size, fps: 24, frames: 72, quantized: true,
    motion: { type: "typing-keyframes", pose_sequence: sequence } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Keep the original CLI usable without leaving the active manifest stale.
  const child = spawnSync(process.execPath, [path.join(root, "scripts/design/build-one-presence-hd.mjs"),
    ...process.argv.slice(2)], { stdio: "inherit" });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
