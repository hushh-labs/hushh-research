// Use Mermaid's external-dependency entry so the locked sanitizer is effective.
// Distributed Mermaid browser bundles embed their own older DOMPurify copy.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireWeb = createRequire(new URL("../hushh-webapp/package.json", import.meta.url));

export async function mermaidBrowserBundle() {
  const { rolldown } = await import(pathToFileURL(requireWeb.resolve("rolldown")).href);
  const bundle = await rolldown({
    input: requireWeb.resolve("mermaid/dist/mermaid.core.mjs"),
    platform: "browser",
    cwd: fileURLToPath(new URL("../hushh-webapp/", import.meta.url)),
  });
  try {
    const { output } = await bundle.generate({
      format: "iife",
      name: "HusshMermaid",
      exports: "default",
      codeSplitting: false,
      footer: "globalThis.mermaid = HusshMermaid;",
    });
    if (output.length !== 1 || output[0].type !== "chunk") {
      throw new Error("Expected one self-contained Mermaid script");
    }
    return output[0].code;
  } finally {
    await bundle.close();
  }
}
