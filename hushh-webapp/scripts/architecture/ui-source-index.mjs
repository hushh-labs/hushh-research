import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// CI installs only this locked parser; normal app installs use their own copy.
const tooling = createRequire(new URL('./ui-contract-tools/package.json', import.meta.url));
const app = createRequire(import.meta.url);
export const ts = (() => {
  try { return tooling('typescript'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    try { return app('typescript'); }
    catch (missing) {
      throw new Error('UI contract parser missing. Run npm ci in hushh-webapp/scripts/architecture/ui-contract-tools, then retry ui:doctor.', { cause: missing });
    }
  }
})();

// One fresh, invocation-scoped snapshot. No persistent cache can hide source drift.
export function createUiSourceIndex(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  }
  walk(root);
  files.sort();
  const inventory = new Set(files);
  const contents = new Map();
  const syntax = new Map();
  return {
    files,
    has: file => inventory.has(file),
    read(file) {
      if (!contents.has(file)) contents.set(file, fs.readFileSync(file, 'utf8'));
      return contents.get(file);
    },
    parse(file, source) {
      if (!syntax.has(file)) syntax.set(file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
      return syntax.get(file);
    },
  };
}
