import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const appRoot = process.env.APP_ROOT || "/app";
const chunkRoots = [
  path.join(appRoot, ".next", "server", "chunks"),
  path.join(appRoot, "app", ".next", "server", "chunks"),
  path.join(appRoot, "hushh-webapp", ".next", "server", "chunks"),
];

async function collectServerChunks(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const chunks = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(...(await collectServerChunks(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      chunks.push(absolutePath);
    }
  }

  return chunks;
}

const chunks = (await Promise.all(chunkRoots.map(collectServerChunks))).flat();
if (chunks.length === 0) {
  throw new Error(`No Next.js server chunks found under ${appRoot}`);
}

for (const chunk of chunks) {
  await readFile(chunk);
}

console.info(`[startup] verified ${chunks.length} readable Next.js server chunks`);
