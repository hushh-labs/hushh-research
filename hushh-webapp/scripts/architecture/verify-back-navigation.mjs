import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Existing specialised owners only. New calls, files or aliases fail the ratchet.
const reviewedHistoryOwners = new Map([
  ['lib/navigation/profile-pane.ts', 3], // Its tested, bounded pane-depth history is the owner.
  ['components/one-location/location-immersive-map.tsx', 1], // Existing check-in overlay history; separate from route Back.
  ['app/register-phone/page.tsx', 1], // Auth-owned entry recovery.
  ['app/not-found.tsx', 1], // Unknown-route recovery.
  ['app/global-error.tsx', 1], // Failed app tree cannot use the mounted navigation owner.
]);

export function historyBypasses(source, file = 'screen.tsx') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const calls = [];
  const owners = new Set(['router', 'history', 'window.history', 'globalThis.history']);
  const methods = new Set();
  function aliases(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer.getText(ast);
      if (ts.isIdentifier(node.name) && (owners.has(initializer) || /^useRouter\(\)$/.test(initializer))) owners.add(node.name.text);
      if (ts.isIdentifier(node.name) && [...owners].some(owner => initializer === `${owner}.back` || initializer === `${owner}.go`)) methods.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name) && owners.has(initializer)) {
        for (const element of node.name.elements) if (['back', 'go'].includes(element.propertyName?.getText(ast) ?? element.name.getText(ast))) methods.add(element.name.getText(ast));
      }
    }
    ts.forEachChild(node, aliases);
  }
  aliases(ast);
  function visit(node) {
    if (ts.isCallExpression(node) && methods.has(node.expression.getText(ast))) calls.push(node.getText(ast));
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const target = node.expression.expression.getText(ast);
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.argumentExpression?.text;
      const isOwner = owners.has(target) || /(^|\.)(history|router)$/.test(target);
      if ((method === 'back' && isOwner) || (method === 'go' && isOwner) || (['call','apply','bind'].includes(method) && (methods.has(target) || [...owners].some(owner => target === `${owner}.back` || target === `${owner}.go`)))) calls.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return calls;
}
export function validateHistoryBypasses(sources) {
  for (const [file, source] of sources) {
    const calls = historyBypasses(source, file);
    if (calls.length > (reviewedHistoryOwners.get(file) ?? 0)) throw new Error(`Back hierarchy bypass in ${file}: ${calls.join(', ')}`);
  }
}
async function sourceFiles(dir) {
  const results = [];
  for (const entry of await fs.readdir(dir, {withFileTypes:true})) {
    if (entry.name === '__tests__') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await sourceFiles(file));
    else if (/\.[jt]sx?$/.test(file)) results.push(file);
  }
  return results;
}
export function backSourceRevision(sources, entries) {
  const hash = createHash('sha256');
  for (const [file, source] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (file.startsWith('lib/generated/')) continue;
    hash.update(file + '\0' + source.replace(/\r\n?/g, '\n') + '\0');
  }
  const authored = structuredClone(entries);
  for (const entry of authored) if (entry.backVerification) delete entry.backVerification.sourceRevision;
  hash.update(JSON.stringify(authored));
  return hash.digest('hex');
}
export async function verifyBackNavigation(root, stamp = false) {
  const contractPath = path.join(root, 'lib/navigation/app-route-layout.contract.json');
  const entries = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  const sources = new Map();
  for (const dir of ['app','components','lib']) {
    for (const file of await sourceFiles(path.join(root, dir))) sources.set(path.relative(root, file).split(path.sep).join('/'), await fs.readFile(file, 'utf8'));
  }
  for (const file of sources.keys()) {
    if (!/\/page\.[jt]sx?$/.test(file) || !file.startsWith('app/')) continue;
    const route = '/' + file.slice(4).replace(/(^|\/)page\.[jt]sx?$/, '').split('/').filter(part => !part.startsWith('(')).join('/');
    const entry = entries.find(entry => entry.route.split('?')[0] === route);
    if (!entry?.backVerification?.cases?.length) throw new Error(`New route needs authored Back verification: ${file}`);
  }
  const location = sources.get('components/one-location/redesign/location-redesign-hub.tsx');
  const ast = ts.createSourceFile('hub.tsx', location, ts.ScriptTarget.Latest, true);
  let actions = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'FLOW_TO_ACTION' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) actions = node.initializer.properties.filter(ts.isPropertyAssignment).map(property => property.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!actions.length) throw new Error('Location action authority changed; review Back coverage extraction');
  const cases = entries.find(entry => entry.route === '/one/location')?.backVerification?.cases ?? [];
  for (const action of actions) {
    for (const view of ['now', 'people', 'links']) {
      if (!cases.some(item => { const query = new URL(item.href, 'https://app.test').searchParams; return query.get('action') === action && query.get('view') === view; })) throw new Error(`Location Back scenario missing: action=${action}&view=${view}`);
    }
  }
  validateHistoryBypasses(sources);
  const revision = backSourceRevision(sources, entries);
  const rootContract = entries.find(entry => entry.route === '/')?.backVerification;
  if (!rootContract) throw new Error('The application root must own the reviewed Back source revision');
  if (stamp) {
    rootContract.sourceRevision = revision;
    await fs.writeFile(contractPath, JSON.stringify(entries, null, 2) + '\n');
  } else if (rootContract.sourceRevision !== revision) {
    throw new Error('Back source changed: review parent/query/nested-state cases, then run npm run build:back-contracts and commit the owning route contracts.');
  }
  console.log(`Back contracts cover ${entries.length} routes, ${cases.length} Location scenarios; new history bypasses rejected.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyBackNavigation(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), process.argv.includes('--stamp-reviewed-source'));
