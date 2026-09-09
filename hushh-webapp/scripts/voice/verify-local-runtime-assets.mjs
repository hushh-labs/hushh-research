import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../../", import.meta.url);
const assets = [
  [
    "public/vendor/sherpa-onnx/v1.13.7/sherpa-onnx-asr.js",
    "d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178",
  ],
  [
    "public/vendor/sherpa-onnx/v1.13.7/sherpa-onnx-wasm-main-asr.js",
    "fd9e40cb7f871a94132fd722bde8a18aeb41a7e8cb95eee81a55b510e621c20a",
  ],
  [
    "public/vendor/sherpa-onnx/v1.13.7/sherpa-onnx-wasm-main-asr.wasm",
    "d0c15c3042fd61ca2a158a1eeb8b8c2099201f7580945efc8f729d2830cf746d",
  ],
];

for (const [relativePath, expectedHash] of assets) {
  const bytes = await readFile(new URL(relativePath, root));
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`Pinned local runtime asset changed: ${relativePath}`);
  }
}

console.log(`Pinned local runtime assets valid (${assets.length} files)`);
