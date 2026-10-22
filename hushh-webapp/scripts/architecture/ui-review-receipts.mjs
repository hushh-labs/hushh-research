import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Only inherit the target branch when this PR changes none of this owner's
// inputs. A missing receipt on main's combined merge must not block asset/docs PRs.
export function unchangedFromReviewBase(root, inputs) {
  if (!inputs) return false;
  try {
    let base = process.env.UI_CONTRACT_BASE_SHA;
    if (!base && process.env.CI === 'true') {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      base = event.pull_request?.base?.sha ?? event.merge_group?.base_sha;
      if (!base) return false;
    }
    if (base && !/^[a-f0-9]{40,64}$/.test(base)) return false;
    base ??= 'origin/main';
    // Hooks export repository-local GIT_* variables. Honor the supplied cwd,
    // including independent fixtures, rather than accidentally using the caller's repo.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
    git('merge-base', '--is-ancestor', base, 'HEAD');
    const prefix = git('rev-parse', '--show-prefix').trim();
    const changed = [
      ...git('diff', '--name-only', '-z', '--no-renames', base, '--', '.').split('\0'),
      ...git('ls-files', '--others', '--exclude-standard', '-z', '--', '.').split('\0'),
    ].filter(Boolean).map(file => file.startsWith(prefix) ? file.slice(prefix.length) : file);
    const owned = new Set(inputs);
    return !changed.some(file => owned.has(file)
      || file === 'lib/navigation/app-route-layout.contract.json'
      || file.endsWith('.voice-action-contract.json')
      || /^(package(?:-lock)?\.json|tsconfig\.json|next\.config\.[cm]?[jt]s)$/.test(file)
      || /^scripts\/(architecture|voice)\//.test(file)
      // Deleted/new modules can disappear from the current import graph. Keep
      // this conservative boundary rather than trusting a now-unresolved import.
      || (/^(app|components|lib)\/.+\.[cm]?[jt]sx?$/.test(file) && !file.includes('/__tests__/'))
      || /^(app|components|lib)\/.+\.json$/.test(file));
  } catch {
    // Missing history, an invalid/non-ancestor base or Git failure cannot grant review.
    return false;
  }
}

// Immutable, content-addressed review evidence: unrelated branches add distinct
// files instead of rewriting one shared stamp or every authored action contract.
// A PR's relevant combined changes still require a receipt; checks never mint it.
export async function syncReviewReceipt(root, kind, revision, details, check = false, inputs) {
  if (!['back', 'search'].includes(kind) || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error('Invalid UI review receipt identity');
  }
  const file = path.join(root, 'contracts/ui-review', kind, `${revision}.json`);
  const expected = JSON.stringify({ schema_version: 'ui.review.v1', kind, source_revision: revision, ...details }, null, 2) + '\n';
  let actual;
  try { actual = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (actual?.replace(/\r\n?/g, '\n') === expected) return;
  if (actual !== undefined) throw new Error(`Invalid immutable ${kind} review receipt: ${file}`);
  if (check && unchangedFromReviewBase(root, inputs)) {
    console.log(`${kind}: no relevant changes against the review base; inherited target-branch evidence.`);
    return;
  }
  if (check) throw new Error(`${kind} source review is stale; review the combined behavior, run npm run build:ui-contracts and commit its review receipt.`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, expected, { flag: 'wx' });
}
