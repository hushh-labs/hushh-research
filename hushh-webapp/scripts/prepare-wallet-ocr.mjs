import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync, copyFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const target = fileURLToPath(new URL("../public/vendor/wallet-ocr/", import.meta.url));
const worker = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
const language = require("@tesseract.js-data/eng");
mkdirSync(target, { recursive: true });
copyFileSync(join(worker, "dist/tesseract.min.js"), join(target, "tesseract.min.js"));
copyFileSync(join(worker, "dist/worker.min.js"), join(target, "worker.min.js"));
for (const name of readdirSync(core).filter((name) => /\.wasm(\.js)?$/.test(name))) {
  copyFileSync(join(core, name), join(target, name));
}
copyFileSync(join(language.langPath, "eng.traineddata.gz"), join(target, "eng.traineddata.gz"));
copyFileSync(join(worker, "LICENSE.md"), join(target, "TESSERACT-JS-LICENSE.txt"));
copyFileSync(join(core, "LICENSE"), join(target, "TESSERACT-CORE-LICENSE.txt"));
console.log("Wallet OCR assets ready.");
