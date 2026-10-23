// SPDX-License-Identifier: Apache-2.0
// Compare the real WASM renderer and looping state machine against every frame.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hd = process.argv.includes("--hd");
const assetName = hd ? "hd/working.riv" : "working.riv";
const timing = JSON.parse(await fs.readFile(path.join(root, "public/one-presence/working-animation.json"), "utf8"));
const files = {
  "/rive.js": ["node_modules/@rive-app/canvas/rive.js", "text/javascript"],
  "/rive.wasm": ["public/one-presence/rive.wasm", "application/wasm"],
  "/working.riv": ["public/one-presence/working.riv", "application/octet-stream"],
  "/working.webp": ["public/one-presence/working.webp", "image/webp"],
};
const server = http.createServer(async (request, response) => {
  try {
    // PNG references avoid differences between browser WebP alpha decoding
    // and the PNG textures embedded in Rive. The atlas pixels are unchanged.
    if (request.url === "/working-reference.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(hd ? await fs.readFile(path.join(root, "public/one-presence/hd/working-poses.png"))
        : await sharp(path.join(root, "public/one-presence/working.webp")).png().toBuffer());
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><title>Working Rive validation</title><script src="/rive.js"></script>');
      return;
    }
    const file = files[request.url];
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": file[1] });
    response.end(await fs.readFile(path.join(root, file[0])));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ assetBytes, hd, sequence }) => {
    window.rive.RuntimeLoader.setWasmUrl("/rive.wasm");
    window.rive.RuntimeLoader.setWasmFallbackUrl(null);
    const runtime = await window.rive.RuntimeLoader.awaitInstance();
    const file = await runtime.load(new Uint8Array(assetBytes), undefined, false);
    const name = hd ? "working-hd" : "Working";
    const artboard = file.artboardByName(name);
    const authoredAnimation = artboard.animationByName(name);
    const animation = new runtime.LinearAnimationInstance(authoredAnimation, artboard);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const renderer = runtime.makeRenderer(canvas);
    const probe = document.createElement("canvas");
    probe.width = probe.height = 128;
    const context = probe.getContext("2d", { willReadFrequently: true });
    const atlas = new Image(); atlas.src = "/working-reference.png"; await atlas.decode();
    const references = Array.from({ length: 72 }, (_, index) => {
      context.clearRect(0, 0, 128, 128);
      const frame = hd ? sequence[index] : index;
      const cell = hd ? 314 : 128, columns = hd ? 4 : 9;
      context.drawImage(atlas, frame % columns * cell, Math.floor(frame / columns) * cell, cell, cell, 0, 0, 128, 128);
      return context.getImageData(0, 0, 128, 128).data;
    });
    const read = () => {
      renderer.clear(); artboard.draw(renderer); renderer.flush(); runtime.resolveAnimationFrame();
      context.clearRect(0, 0, 128, 128); context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, 128, 128).data;
    };
    const compare = (pixels, index) => {
      const reference = references[index % 72];
      let difference = 0;
      // Canvas exposes unpremultiplied RGB. At alpha=1 a one-byte rounding
      // difference looks like 255 there, despite being visually one byte.
      // Compare alpha and premultiplied RGB, preserving visible differences.
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset + 3], referenceAlpha = reference[offset + 3];
        difference = Math.max(difference, Math.abs(alpha - referenceAlpha));
        for (let channel = 0; channel < 3; channel++) difference = Math.max(difference,
          Math.abs(Math.round(pixels[offset + channel] * alpha / 255) - Math.round(reference[offset + channel] * referenceAlpha / 255)));
      }
      return difference;
    };
    // Rive stores scale as float32; 314px -> 128 units can round a visible
    // channel by one level. Legacy 128px frames still require exact equality.
    const tolerance = hd ? 1 : 0;
    let maximum = 0, nonidentical = 0, outOfTolerance = 0, changes = 0;
    for (let frame = 0; frame < 72; frame++) {
      animation.time = (frame + 0.01) / 24; animation.apply(1); artboard.advance(0);
      const rendered = read();
      const difference = compare(rendered, frame);
      maximum = Math.max(maximum, difference); if (difference) nonidentical++;
      if (difference > tolerance) outOfTolerance++;
      if (frame && references[frame].some((value, index) => value !== references[frame - 1][index])) changes++;
    }
    const machineBoard = file.artboardByName(name);
    const machine = new runtime.StateMachineInstance(machineBoard.stateMachineByName("State Machine 1"), machineBoard);
    machine.advance(0); machineBoard.advance(0);
    let mismatches = 0;
    for (let frame = 0; frame < 146; frame++) {
      machine.advance(frame ? 1 / 24 : 0.01 / 24); machineBoard.advance(0);
      renderer.clear(); machineBoard.draw(renderer); renderer.flush(); runtime.resolveAnimationFrame();
      context.clearRect(0, 0, 128, 128); context.drawImage(canvas, 0, 0);
      if (compare(context.getImageData(0, 0, 128, 128).data, frame) > tolerance) mismatches++;
    }
    const result = { name: artboard.name, fps: authoredAnimation.fps, duration_seconds: authoredAnimation.duration / authoredAnimation.fps,
      loop: authoredAnimation.loopValue === 1, frames_rendered: 72, max_pixel_channel_difference: maximum,
      comparison: hd ? "Premultiplied RGBA; one-level float32 scaling-rounding tolerance" : "Premultiplied RGBA; exact 8-bit visible channels and alpha",
      allowed_pixel_channel_difference: tolerance, out_of_tolerance_frames: outOfTolerance,
      nonidentical_frames: nonidentical, motion_changes: changes,
      state_machine_frames_tested: 146, state_machine_mismatches: mismatches };
    machine.delete(); machineBoard.delete(); animation.delete(); artboard.delete(); file.delete(); renderer.delete();
    return result;
  }, { assetBytes: [...await fs.readFile(path.join(root, "public/one-presence", assetName))], hd,
    sequence: timing.pose_sequence });
  assert.deepEqual(errors, []);
  assert.equal(result.fps, 24); assert.equal(result.duration_seconds, 3); assert.equal(result.loop, true);
  assert.ok(result.max_pixel_channel_difference <= result.allowed_pixel_channel_difference);
  assert.equal(result.out_of_tolerance_frames, 0);
  if (!hd) assert.equal(result.nonidentical_frames, 0);
  assert.equal(result.state_machine_mismatches, 0); assert.ok(result.motion_changes >= 30);
  if (process.argv.includes("--write")) {
    if (hd) {
      await fs.writeFile(path.join(root, "public/one-presence/hd/working-validation.json"), `${JSON.stringify({
        file: assetName, artboards: [result], runtime: "@rive-app/canvas 2.44.2 (advanced API)",
      }, null, 2)}\n`);
    } else {
    const destination = path.join(root, "public/one-presence/rive-validation.json");
    const report = JSON.parse(await fs.readFile(destination, "utf8"));
    report[report.findIndex(entry => entry.file === "working.riv")] = {
      file: "working.riv", artboards: [result], runtime: "@rive-app/canvas 2.44.2 (advanced API)",
    };
    await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
