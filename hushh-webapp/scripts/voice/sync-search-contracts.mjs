import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ts, createUiSourceIndex } from '../architecture/ui-source-index.mjs';
import { syncReviewReceipt } from '../architecture/ui-review-receipts.mjs';

const extensions = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'];
export const normalizeSource = (text) => text.replace(/\r\n?/g, '\n');
export function sourceRevision(sources) {
  const hash = createHash('sha256');
  for (const [file, text] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(file + '\0' + normalizeSource(text) + '\0');
  }
  return hash.digest('hex');
}
export async function collectSources(root, entries, index = createUiSourceIndex(root)) {
  const sources = new Map();
  async function resolveModule(from, specifier) {
    const base = specifier.startsWith('@/') ? path.join(root, specifier.slice(2))
      : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null;
    if (!base || !base.startsWith(root + path.sep)) return null;
    for (const candidate of [base, ...extensions.map(ext => base + ext), ...extensions.map(ext => path.join(base, 'index' + ext))]) {
      if (!extensions.includes(path.extname(candidate))) continue;
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      if (relative.startsWith('contracts/') || relative.startsWith('lib/generated/') || relative.endsWith('.generated.json') || relative.endsWith('.voice-action-contract.json')) continue;
      if (index.has(candidate)) return candidate;
    }
    return null;
  }
  async function visit(file) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (sources.has(relative)) return;
    const text = index.read(file);
    sources.set(relative, text);
    if (file.endsWith('.json')) return;
    const ast = index.parse(file, text);
    const imports = [];
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, walk);
    }
    walk(ast);
    for (const specifier of imports) {
      const dependency = await resolveModule(file, specifier);
      if (dependency) await visit(dependency);
    }
  }
  for (const entry of entries) await visit(path.resolve(root, entry));
  return sources;
}
export function collectSearchControlIds(sources) {
  const ids = new Set();
  for (const [file, text] of sources) {
    if (file.endsWith('.json') || !text.includes('data-voice-control-id')) continue;
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function walk(node) {
      if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'data-voice-control-id') {
        let value = node.initializer;
        if (value && ts.isJsxExpression(value)) value = value.expression;
        if (value && ts.isStringLiteralLike(value)) ids.add(value.text);
      }
      ts.forEachChild(node, walk);
    }
    walk(ast);
  }
  return ids;
}
export function validateControlCoverage(sources, contracts) {
  const declared = new Set(contracts.flatMap(contract => (contract.actions || []).flatMap(action => action.control_ids || [])));
  const exemptions = new Set(contracts.flatMap(contract => Object.keys(contract.search?.legacy_control_exemptions || {})));
  const missing = [...collectSearchControlIds(sources)].filter(id => !declared.has(id) && !exemptions.has(id));
  if (missing.length) throw new Error(`Search controls need authored actions/control_ids before regeneration: ${missing.sort().join(', ')}`);
}
export async function syncSearchContracts(root, check = false, index = createUiSourceIndex(root)) {
  const layout = JSON.parse(await fs.readFile(path.join(root, 'lib/navigation/app-route-layout.contract.json'), 'utf8'));
  const contracts = index.files.filter(file => file.endsWith('.voice-action-contract.json'));
  const appFiles = index.files.filter(file => file.startsWith(path.join(root, 'app') + path.sep));
  const pages = appFiles.filter(file => /[\\/]page\.tsx$/.test(file));
  const uiEntries = appFiles.filter(file => /[\\/](page|layout|template|loading|error|global-error|not-found|default)\.[jt]sx?$/.test(file));
  const pageEntries = pages.map(file => path.relative(root, file).split(path.sep).join('/'));
  const coveredFiles = new Set(layout.map(entry => entry.shellVerification?.file));
  const coveredRoutes = new Set(layout.map(entry => entry.route.split('?')[0]));
  // Every physical page must already be represented in the authoritative route layout.
  for (const page of pageEntries) {
    if (!coveredFiles.has(page)) {
      // Some shells verify a component instead; match the physical Next route.
      const route = '/' + page.slice(4, -9).split('/').filter(segment => !segment.startsWith('(')).join('/');
      if (!coveredRoutes.has(route || '/')) throw new Error(`New page ${page} needs a web route/search contract.`);
    }
  }
  // Include the entire route UI import graph. Shared changes require a new review receipt.
  // Hashes detect drift; they never claim to infer the meaning of a new interaction.
  const sources = await collectSources(root, uiEntries.map(file => path.relative(root, file)), index);
  validateControlCoverage(sources, await Promise.all(contracts.map(async file => JSON.parse(await fs.readFile(file, 'utf8')))));
  const revision = sourceRevision(sources);
  let stale = 0;
  for (const file of contracts) {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const expected = { ...raw.search };
    delete expected.source_revision;
    delete expected.source_module_count;
    if (!Object.hasOwn(raw.search || {}, 'source_revision') && !Object.hasOwn(raw.search || {}, 'source_module_count')) continue;
    stale++;
    if (!check) {
      raw.search = expected;
      const original = await fs.readFile(file, 'utf8');
      const withoutSearch = original.replace(/,\s*"search"\s*:\s*\{[\s\S]*?\}\s*\}\s*$/, '\n}');
      const metadata = JSON.stringify(expected, null, 2).split('\n').map((line, index) => index ? '  ' + line : line).join('\n');
      await fs.writeFile(file, withoutSearch.trimEnd().replace(/\s*\}$/,  ',\n  "search": ' + metadata + '\n}') + '\n');
    }
  }
  if (check && stale) throw new Error(`${stale} search contracts contain stale legacy source stamps; run npm run build:ui-contracts to migrate them.`);
  await syncReviewReceipt(root, 'search', revision, { source_module_count: sources.size }, check, [...sources.keys()]);
  console.log(`Search contracts: ${contracts.length} contracts cover ${pageEntries.length} pages and ${sources.size} source modules${check ? ' (checked)' : ' (refreshed)'}.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncSearchContracts(process.cwd(), process.argv.includes('--check')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
