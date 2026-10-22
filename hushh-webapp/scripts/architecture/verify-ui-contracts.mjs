import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createUiSourceIndex } from './ui-source-index.mjs';
import { verifyBackNavigation } from './verify-back-navigation.mjs';
import { syncSearchContracts } from '../voice/sync-search-contracts.mjs';

export async function runUiChecks(checks) {
  const results = await Promise.all(checks.map(async ([name, run]) => {
    try { await run(); return { name, ok: true }; }
    catch (error) { return { name, ok: false, error: error.message }; }
  }));
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ': ' + result.error : ''}`);
  return results.every(result => result.ok);
}

function checkScript(root, script, args = ['--check']) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${script} exited ${signal ?? code}`)));
  });
}

export async function verifyUiContracts(root, started = performance.now()) {
  const index = createUiSourceIndex(root);
  const ok = await runUiChecks([
    ['Back hierarchy, coverage and freshness', () => verifyBackNavigation(root, false, index)],
    ['Search coverage and freshness', () => syncSearchContracts(root, true, index)],
    ['Surface map', () => checkScript(root, 'scripts/architecture/generate-surface-map.mjs')],
    ['Action gateway', () => checkScript(root, 'scripts/voice/generate-kai-action-gateway.mjs')],
    ['Siri action contract', () => checkScript(root, 'scripts/native/verify-siri-action-contract.mjs')],
    ['Route orchestration', () => checkScript(root, 'scripts/voice/generate-route-orchestration-index.mjs')],
    ['Validator mutation regressions', () => checkScript(root, '--test', ['scripts/architecture/back-navigation.test.mjs', 'scripts/voice/search-contracts.test.mjs'])],
  ]);
  console.log(`UI contract validation: ${((performance.now() - started) / 1000).toFixed(2)}s (execution target: 5–10s; install and runner startup excluded).`);
  if (!ok) console.error('Review authored Back cases and Search actions first. Then run npm run build:ui-contracts and npm run verify:ui-contracts. See docs/reference/architecture/ui-contract-contributor-guide.md.');
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  // Node's performance clock starts at process startup, including parser imports.
  verifyUiContracts(root, 0).then(ok => { process.exitCode = ok ? 0 : 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
