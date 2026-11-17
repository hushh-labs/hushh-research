// SPDX-License-Identifier: Apache-2.0
// Native Rive runtime records, using the public rive-app/rive-runtime schema.
// Generate the profile and compact assets from the same authored portraits.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildWorkingPresence } from "./build-one-working-presence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/one-presence");
const check = process.argv.includes("--check");
function emit(target, value) {
  if (check) {
    if (!fs.readFileSync(target).equals(value)) throw Error(`Stale One presence asset: ${target}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
}
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
  connected: { image: "profile-hd.png", lift: 0.8, turns: 1, tilt: 0, breath: 0.038 },
  thinking: { image: "thinking-hd.png", lift: 1.2, turns: 1, tilt: 0.004 },
  working: { image: "drafting-hd.png" },
  answering: { image: "answering-hd.png", lift: 1, turns: 2, tilt: 0.003 },
};

function portraitRive(state, pose, texture, width, variant) {
  const name = `${state}-${variant}`;
  // Anchor the idle breathing motion near the feet so the name gap stays stable.
  const pivot = pose.breath ? 114 : 64;
  const records = [
    record(23), // Backboard
    record(105, { 203: name, 204: 1, 207: width, 208: width }),
    record(106, { 212: texture }),
    record(1, { 4: name, 7: 128, 8: 128, 236: 0 }),
    record(2, { 4: "Pose", 5: 0, 13: 64, 14: pivot }),
    record(100, { 4: "HD portrait", 5: 1, 13: 0, 14: 64 - pivot, 16: 128 / width, 17: 128 / width, 206: 0, 380: 0.5, 381: 0.5 }),
    record(31, { 55: name, 56: 24, 57: 72, 59: 1, 376: 1 }),
    record(25, { 51: 1 }),
  ];
  // Periodic paths share their start and end values. The Rive state machine
  // owns interpolation and playback through each loop boundary.
  const properties = new Map([
    [14, wave => pivot - pose.lift * wave],
    [15, (_, phase) => pose.tilt * Math.sin(phase)],
  ]);
  if (pose.breath) {
    properties.set(16, wave => 1 + pose.breath * 0.5 * wave);
    properties.set(17, wave => 1 + pose.breath * wave);
  }
  for (const [property, value] of properties) {
    records.push(record(26, { 53: property }));
    for (let frame = 0; frame <= 72; frame += 3) {
      const phase = frame / 72 * Math.PI * 2 * pose.turns;
      records.push(record(30, { 67: frame, 68: 1, 70: value((1 - Math.cos(phase)) / 2, phase) }));
    }
  }
  records.push(record(53, { 55: "State Machine 1" }), record(57, { 55: "Layer 1" }),
    record(63), record(65, { 151: 3, 158: 0 }), record(62), record(64), record(61, { 149: 0 }));
  return Buffer.concat([Buffer.from("RIVE"), u(7), u(4), u(0), u(0), ...records]);
}

const profile = {};
const compact = {};
const fallback = {};
for (const [state, pose] of Object.entries(poses)) {
  const png = fs.readFileSync(path.join(root, pose.image));
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw Error(`Expected PNG: ${pose.image}`);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 1024 || height !== width) throw Error(`HD square source required: ${pose.image}`);
  const small = await sharp(png).resize(320, 320).webp({ quality: 94 }).toBuffer();
  const still = await sharp(png).resize(80, 80).webp({ quality: 83 }).toBuffer();
  emit(path.join(root, "compact", `${state}.webp`), small);
  fallback[state] = `data:image/webp;base64,${still.toString("base64")}`;
  const file = `${state}.riv`;
  if (state === "working") {
    const typing = await buildWorkingPresence({ check });
    profile[file] = typing.profile;
    compact[file] = typing.compact;
  } else {
    for (const [variant, manifest, texture, edge] of [
      ["hd", profile, png, width], ["compact", compact, small, 320],
    ]) {
      const riv = portraitRive(state, pose, texture, edge, variant);
      emit(path.join(root, variant, file), riv);
      manifest[file] = { bytes: riv.length, sha256: sha(riv), source: pose.image, source_sha256: sha(png),
        texture_width: edge, texture_height: edge, textures: 1,
        artboard: 128, fps: 24, frames: 72, quantized: true, motion: pose };
    }
  }
  compact[`${state}.webp`] = { bytes: small.length, sha256: sha(small), source: pose.image, source_sha256: sha(png) };
}
for (const [variant, manifest] of [["hd", profile], ["compact", compact]]) {
  emit(path.join(root, variant, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
}
emit(path.resolve(root, "../../components/agent/one-presence-fallback.generated.ts"),
  Buffer.from(`// Generated by scripts/design/build-one-presence-hd.mjs.\nexport const onePresenceFallback = ${JSON.stringify(fallback, null, 2)} as const;\n`));
console.log(`One presence assets ${check ? "verified" : "built"} for compact and profile artwork.`);
