#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const docTargets = ['README.md', 'AGENTS.md', 'getting_started.md', 'TESTING.md',
  'contributing.md', 'docs', '.agents', 'consent-protocol/docs', 'hushh-webapp/docs'];
const ignoredDirs = new Set(['node_modules', '.next', 'DerivedData', '.pytest_cache',
  '.git', '.venv', 'dist', 'build', '.local', 'imports']);
const pathPrefixes = ['bin/', 'docs/', '.agents/', 'consent-protocol/', 'hushh-webapp/',
  'scripts/', 'deploy/', 'data/'];
const normalize = value => value.replace(/\\/g, '/');

function walkMarkdown(root, target) {
  const full = path.join(root, target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return target.endsWith('.md') ? [target] : [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap(entry => {
    if (ignoredDirs.has(entry.name) || entry.isSymbolicLink()) return [];
    return walkMarkdown(root, normalize(path.join(target, entry.name)));
  });
}

function withoutFences(source) {
  let fence;
  return source.split(/\r?\n/).map(line => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  }).join('\n').replace(/<!--[\s\S]*?-->/g, '');
}

// GitHub fragments are generated per document: punctuation is removed and
// colliding headings receive suffixes. Explicit HTML anchors remain valid.
function headingAnchors(source) {
  const text = withoutFences(source);
  const anchors = new Set();
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
  const used = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let heading = lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/)?.[1];
    if (!heading && i + 1 < lines.length && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) &&
        lines[i].trim() && !lines[i].includes('|')) heading = lines[i];
    if (!heading) continue;
    const base = heading.replace(/<[^>]*>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/&amp;/g, '&').replace(/&(?:lt|gt);/g, '').toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug); anchors.add(slug);
  }
  return anchors;
}

function localTarget(root, file, token, historicalRevisions) {
  let value = token.trim().replace(/^<(.+)>$/, '$1').replace(/\s+["'][^]*$/, '');
  if (/^https?:/.test(value)) {
    const match = value.match(/^https:\/\/github\.com\/hushh-labs\/hushh-research\/(?:blob|tree)\/([^/]+)\/(.*)$/);
    if (!match) return null;
    // Pinned history is evidence, not a promise that the old file exists in HEAD.
    if (/^[a-f0-9]{7,40}$/.test(match[1])) {
      historicalRevisions?.add(match[1]);
      return null;
    }
    if (!['main', 'dev', 'uat'].includes(match[1])) return null;
    value = '/' + match[2];
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const [target, ...parts] = value.split('#');
  let decoded;
  let fragment;
  try { decoded = decodeURIComponent(target); fragment = decodeURIComponent(parts.join('#')); }
  catch { return { error: 'invalid URL encoding' }; }
  let full;
  if (!decoded) full = path.join(root, file);
  else if (decoded === './bin/hushh') full = path.join(root, 'bin/hushh');
  else if (decoded.startsWith('/')) full = path.join(root, decoded.slice(1));
  else {
    full = path.resolve(root, path.dirname(file), decoded);
    // Existing documentation also contains explicitly repository-root paths.
    if (!fs.existsSync(full) && pathPrefixes.some(prefix => decoded.startsWith(prefix))) full = path.join(root, decoded);
  }
  if (!full.startsWith(root + path.sep) && full !== root) return { error: 'target leaves repository' };
  return { full, fragment };
}

function checkLinks({ workspaceRoot = repoRoot, targets = docTargets, codePaths = true } = {}) {
  const root = path.resolve(workspaceRoot);
  const files = [...new Set(targets.flatMap(target => walkMarkdown(root, target)))].sort();
  const errors = [];
  const anchors = new Map();
  const historicalRevisions = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const text = withoutFences(source);
    const prose = text.replace(/`[^`\n]+`/g, ' ').replace(/\\[\[\]]/g, '');
    const tokens = [...prose.matchAll(/\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\)/g)].map(match => match[1]);
    const definitions = new Map([...text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)]
      .map(match => [match[1].toLowerCase(), match[2]]));
    for (const match of prose.matchAll(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
      const label = (match[2] || match[1]).toLowerCase();
      if (definitions.has(label)) tokens.push(definitions.get(label));
      // Undefined references are literal Markdown text, e.g. adjacent regex classes.
    }
    // Validate definitions even when their references use Markdown's shortcut form.
    tokens.push(...definitions.values());
    for (const token of tokens) {
      const resolved = localTarget(root, file, token, historicalRevisions);
      if (!resolved) continue;
      if (resolved.error || !fs.existsSync(resolved.full)) {
        errors.push(`${file}: broken markdown link -> ${token}${resolved.error ? ` (${resolved.error})` : ''}`);
        continue;
      }
      if (resolved.fragment && resolved.full.endsWith('.md')) {
        if (!anchors.has(resolved.full)) anchors.set(resolved.full, headingAnchors(fs.readFileSync(resolved.full, 'utf8')));
        if (!anchors.get(resolved.full).has(resolved.fragment)) errors.push(`${file}: missing heading -> ${token}`);
      }
    }
    if (!codePaths) continue;
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1];
      if (/\s|\*|\.\.\.|[{}<>]/.test(token) || token.startsWith('/') || token.startsWith('~') ||
          /^\w+:/.test(token) || /(?:^|\/)\.env(?:\.|$)/.test(token)) continue;
      if (!pathPrefixes.some(prefix => token.startsWith(prefix)) && !token.startsWith('./') && !token.startsWith('../')) continue;
      if (token.startsWith('.agents/.local/')) continue; // Optional ignored host state, never a source asset.
      const cleaned = token.replace(/[),.;:]+$/g, '').replace(/:\d+(?:-\d+)?$/, '');
      const resolved = localTarget(root, file, cleaned);
      if (resolved?.error || !fs.existsSync(resolved.full)) errors.push(`${file}: unresolved code path -> ${token}`);
    }
  }
  return { files: files.length, errors, historicalRevisions: [...historicalRevisions] };
}

function selfTest() {
  const os = require('node:os');
  const assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hussh-doc-links-'));
  const write = (file, text) => { const full = path.join(root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
  try {
    write('AGENTS.md', '[Instructions](.agents/instructions.md#recovery-1)\n');
    write('.agents/instructions.md', '# Recovery\n# Recovery\n[Module](../docs/module.md#new-heading)\n');
    write('docs/module.md', '# New heading\n[Root](../AGENTS.md)\n[Same repo](https://github.com/hushh-labs/hushh-research/blob/main/AGENTS.md)\n');
    assert.deepEqual(checkLinks({ workspaceRoot: root }).errors, []);
    write('docs/module.md', '# Renamed\n[Missing](absent.md)\n');
    const failed = checkLinks({ workspaceRoot: root }).errors;
    assert(failed.some(error => error.includes('missing heading')));
    assert(failed.some(error => error.includes('absent.md')));
    assert(headingAnchors('# A\n# A\n# A-1\n# A\n```md\n# Ignored\n```').has('a-1-1'));
    assert(!headingAnchors('```md\n# Ignored\n```').has('ignored'));
    assert(headingAnchors('<a id="explicit"></a>\n# Héllo, **world**!').has('héllo-world'));
    write('docs/module.md', '# New heading\n[relative][local]\n[local]: ../AGENTS.md\n');
    assert.deepEqual(checkLinks({ workspaceRoot: root }).errors, []);
    console.log('OK: doc links controls pass (moved file, agent guidance, headings, duplicates and reference links)');
  } finally { fs.rmSync(root, { recursive: true }); }
}

module.exports = { checkLinks, headingAnchors };
if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    const result = checkLinks();
    if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
    else console.log(`OK: docs integrity passed (${result.files} pages; paths and headings)`);
  }
}
