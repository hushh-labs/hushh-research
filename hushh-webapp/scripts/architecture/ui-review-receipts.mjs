import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Only inherit the target branch when this PR changes none of this owner's
// inputs. A missing receipt on main's combined merge must not block asset/docs PRs.
export function unchangedFromReviewBase(root, inputs) {
  if (!inputs?.length) return false;
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
    const relative = file => file.startsWith(prefix) ? file.slice(prefix.length) : file;
    const tracked = new Set(git('ls-files', '--full-name', '-z', '--', '.').split('\0').filter(Boolean).map(relative));
    // Ignored fixture/workspace trees inherit the parent Git repository but
    // have no reviewed inputs. Absence from Git's diff is not review evidence.
    if (inputs.some(file => !tracked.has(file))) return false;
    const changed = [
      ...git('diff', '--name-only', '-z', '--no-renames', base, '--', '.').split('\0'),
      ...git('ls-files', '--others', '--exclude-standard', '-z', '--', '.').split('\0'),
    ].filter(Boolean).map(relative);
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

// Only the current local review is cached. Durable technical fingerprints live
// in commit trailers, never one generated source file per review revision.
const kinds = ['back', 'search'];
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cacheFile = (root, kind) => path.join(root, 'tmp/ui-review', `${kind}.json`);

export function reviewTrailer(kind, revision, details) {
  if (!kinds.includes(kind) || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid UI review receipt identity');
  const expected = JSON.stringify({ schema_version: 'ui.review.v1', kind, source_revision: revision, ...details }, null, 2) + '\n';
  return `UI-Review-${kind === 'back' ? 'Back' : 'Search'}: ${revision} ${digest(expected)}`;
}

function reviewHistory(root) {
  try {
    const output = execFileSync('git', ['log', '-128', '--format=%(trailers:only,key=UI-Review-Back,key=UI-Review-Search)%x00', 'HEAD'], {
      cwd: root, env: gitEnv(), encoding: 'utf8', stdio: 'pipe', maxBuffer: 512 * 1024,
    });
    return output.split('\0').flatMap(commit => commit.split(/\r?\n/));
  } catch {
    // Absent/shallow history is not evidence; the caller must fail closed.
    return [];
  }
}

function committedReview(root, trailer) {
  return reviewHistory(root).includes(trailer);
}

export async function syncReviewReceipt(root, kind, revision, details, check = false, inputs) {
  const trailer = reviewTrailer(kind, revision, details);
  const file = cacheFile(root, kind);
  const expected = JSON.stringify({ schema_version: 'ui.review.v1', kind, source_revision: revision, ...details }, null, 2) + '\n';
  const ci = ['true', '1'].includes(process.env.CI) || process.env.GITHUB_ACTIONS === 'true';
  let actual;
  let parsed;
  if (!check || !ci) {
    try { actual = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (actual !== undefined) {
      try { parsed = JSON.parse(actual); }
      catch { throw new Error(`Invalid immutable ${kind} review receipt: ${file}`); }
      if (parsed.schema_version !== 'ui.review.v1' || parsed.kind !== kind || !/^[a-f0-9]{64}$/.test(parsed.source_revision)) {
        throw new Error(`Invalid immutable ${kind} review receipt: ${file}`);
      }
      if (parsed.source_revision === revision && actual.replace(/\r\n?/g, '\n') !== expected) {
        throw new Error(`Invalid immutable ${kind} review receipt: ${file}`);
      }
    }
  }
  if (check) {
    if ((!ci && actual?.replace(/\r\n?/g, '\n') === expected) || committedReview(root, trailer)) return;
    if (unchangedFromReviewBase(root, inputs)) {
      console.log(`${kind}: no relevant changes against the review base; inherited target-branch evidence.`);
      return;
    }
    throw new Error(`${kind} source review is stale; review the combined behavior, run npm run build:ui-contracts and commit with the tracked review-metadata hook enabled.`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (actual?.replace(/\r\n?/g, '\n') !== expected) {
    const temporary = `${file}.${process.pid}.tmp`;
    try { await fs.writeFile(temporary, expected); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  console.log(`${kind}: local review refreshed; commit metadata: ${trailer}`);
}

export async function appendReviewTrailers(root, messageFile) {
  const args = ['interpret-trailers', '--in-place', '--if-exists', 'replace', '--if-missing', 'add'];
  const inherited = reviewHistory(root);
  for (const kind of kinds) {
    const name = kind === 'back' ? 'Back' : 'Search';
    const previous = inherited.find(line => new RegExp(`^UI-Review-${name}: [a-f0-9]{64} [a-f0-9]{64}$`).test(line));
    let bytes;
    try { bytes = await fs.readFile(cacheFile(root, kind), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Carry existing technical proof across later commits; never mint a new
      // source fingerprint. CI still checks it against the actual candidate.
      if (previous) args.push('--trailer', previous);
      continue;
    }
    const { schema_version, kind: recordedKind, source_revision, ...details } = JSON.parse(bytes);
    if (schema_version !== 'ui.review.v1' || recordedKind !== kind) throw new Error('Invalid local UI review metadata');
    args.push('--trailer', reviewTrailer(kind, source_revision, details));
  }
  if (args.length > 6) execFileSync('git', [...args, messageFile], { cwd: root, env: gitEnv(), stdio: 'pipe' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--append-commit-trailers' || !process.argv[3]) throw new Error('Expected a commit message file');
  await appendReviewTrailers(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), path.resolve(process.argv[3]));
}
