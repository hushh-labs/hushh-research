// SPDX-License-Identifier: Apache-2.0
// Native Rive runtime records, using the public rive-app/rive-runtime schema.
// One source texture per scene keeps decoded memory bounded. Original frame
// exports remain separate; these are newly authored HD portrait motions.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildWorkingPresence } from "./build-one-working-presence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/one-presence");
const check = process.argv.includes("--check");
const u = number => {
  const bytes = [];
  do { const byte = number & 127; number >>>= 7; bytes.push(byte | (number ? 128 : 0)); } while (number);
  return Buffer.from(bytes);
};
const f = value => { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return bytes; };
const bytes = value => Buffer.concat([u(value.length), value]);
const strings = new Set([4, 55, 203]);
const floats = new Set([7, 8, 13, 14, 15, 16, 17, 70, 207, 208, 380, 381]);
const record = (type, properties = {}) => Buffer.concat([
  u(type), ...Object.entries(properties).flatMap(([key, value]) => [u(Number(key)),
    Number(key) === 212 ? bytes(value) : strings.has(Number(key)) ? bytes(Buffer.from(value))
      : floats.has(Number(key)) ? f(value) : u(value)]), u(0),
]);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const poses = {
  connected: { image: "profile-hd.png", lift: 0.8, turns: 1, tilt: 0 },
  thinking: { image: "thinking-hd.png", lift: 1.2, turns: 1, tilt: 0.004 },
  working: { image: "drafting-hd.png", lift: 0.8, turns: 3, tilt: 0.002 },
  answering: { image: "answering-hd.png", lift: 1, turns: 2, tilt: 0.003 },
};
const manifest = {};
for (const [state, pose] of Object.entries(poses)) {
  if (state === "working") {
    manifest["working.riv"] = await buildWorkingPresence({ check });
    continue;
  }
  const png = fs.readFileSync(path.join(root, pose.image));
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw Error(`Expected PNG: ${pose.image}`);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 1024 || height !== width) throw Error(`HD square source required: ${pose.image}`);
  const records = [
    record(23), // Backboard
    record(105, { 203: `${state}-hd`, 204: 1, 207: height, 208: width }),
    record(106, { 212: png }),
    record(1, { 4: `${state}-hd`, 7: 128, 8: 128, 236: 0 }),
    record(2, { 4: "Pose", 5: 0, 13: 64, 14: 64 }),
    record(100, { 4: "HD portrait", 5: 1, 13: 0, 14: 0, 16: 128 / width, 17: 128 / height, 206: 0, 380: 0.5, 381: 0.5 }),
    record(31, { 55: `${state}-hd`, 56: 24, 57: 72, 59: 1, 376: 1 }),
    record(25, { 51: 1 }),
  ];
  // Sample smooth periodic paths, with identical start/end values. Rive owns
  // interpolation and playback; no application timer drives these poses.
  for (const property of [14, 15]) {
    records.push(record(26, { 53: property }));
    for (let frame = 0; frame <= 72; frame += 3) {
      const phase = frame / 72 * Math.PI * 2 * pose.turns;
      const value = property === 14 ? 64 - pose.lift * (1 - Math.cos(phase)) / 2 : pose.tilt * Math.sin(phase);
      records.push(record(30, { 67: frame, 68: 1, 70: value }));
    }
  }
  records.push(record(53, { 55: "State Machine 1" }), record(57, { 55: "Layer 1" }),
    record(63), record(65, { 151: 3, 158: 0 }), record(62), record(64), record(61, { 149: 0 }));
  const riv = Buffer.concat([Buffer.from("RIVE"), u(7), u(4), u(0), u(0), ...records]);
  const target = path.join(root, "hd", `${state}.riv`);
  if (check) {
    if (!fs.readFileSync(target).equals(riv)) throw Error(`Stale HD Rive export: ${state}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, riv);
  }
  manifest[`${state}.riv`] = { bytes: riv.length, sha256: sha(riv), source: pose.image,
    source_sha256: sha(png), texture_width: width, texture_height: height, textures: 1,
    artboard: 128, fps: 24, frames: 72, quantized: true, motion: pose };
}
const text = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestPath = path.join(root, "hd/manifest.json");
if (check) {
  if (fs.readFileSync(manifestPath, "utf8") !== text) throw Error("Stale HD Rive manifest");
} else fs.writeFileSync(manifestPath, text);
console.log(`Rive exports ${check ? "verified" : "built"}: three HD portrait loops and an articulated typing loop.`);
