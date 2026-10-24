/** Source evidence only: JSX is not proof that a branch mounted in a browser. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = process.cwd();
const output = path.join(root, "docs/ui-contracts/consent-source-inventory.json");
const previous = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
const baseline = new Map(previous?.elements.map(item => [item.id, item.before]) ?? []);
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) collect(name);
    else if (/\.[tj]sx?$/.test(name)) files.push(name);
  }
}
collect("components/consent");
collect("components/agent/consent");
files.push("app/one/consent/page.tsx", "app/consents/page.tsx",
  "lib/consent/document-request-payment-view.ts", "lib/consent/document-request-setup.ts",
  "lib/consent/document-request-price.ts", "lib/consent/consent-owner-copy.ts",
  "lib/consent/consent-display.ts", "lib/payouts/review-copy.ts");
const elements = [];
const copySources = [];
const clean = value => value.replace(/\s+/g, " ").trim();
function containsJsx(node) {
  if (!node) return false;
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return ts.forEachChild(node, containsJsx) === true;
}
for (const file of files.sort()) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const counts = new Map();
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      const attributes = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute)
        .map(item => [item.name.getText(ast), item.initializer ? clean(item.initializer.getText(ast)) : "true"]));
      const parent = ts.isJsxElement(node.parent) ? node.parent : node;
      const text = ts.isJsxElement(parent) ? parent.children.filter(item => ts.isJsxText(item)
        || (ts.isJsxExpression(item) && item.expression && !containsJsx(item.expression)
          && !/\.(?:map|flatMap)\(/.test(item.expression.getText(ast))))
        .map(item => clean(item.getText(ast))).filter(Boolean) : [];
      const control = /(?:Button|Input|Textarea|Select|Checkbox|Switch|Trigger|Action|Cancel|Row)$/.test(tag)
        || ["button", "input", "select", "textarea", "a", "summary"].includes(tag);
      const visibleAttributes = Object.fromEntries(Object.entries(attributes).filter(([key]) =>
        /^(?:title|description|label|placeholder|aria-|emptyText|helper|message|value|loadingText|busyText)/.test(key)));
      if (control || text.length || Object.keys(visibleAttributes).length) {
        let owner = "module";
        const conditions = [];
        for (let cursor = node.parent; cursor; cursor = cursor.parent) {
          if (ts.isFunctionDeclaration(cursor) && cursor.name) { owner = cursor.name.text; break; }
          if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name)) { owner = cursor.name.text; break; }
        }
        for (let cursor = node.parent; cursor; cursor = cursor.parent) {
          if (ts.isConditionalExpression(cursor)) conditions.push(clean(cursor.condition.getText(ast)));
          if (ts.isBinaryExpression(cursor) && cursor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
            conditions.push(clean(cursor.left.getText(ast)));
          if (ts.isIfStatement(cursor)) conditions.push(clean(cursor.expression.getText(ast)));
        }
        const key = `${file}#${owner}/${tag}`;
        const ordinal = (counts.get(key) ?? 0) + 1;
        counts.set(key, ordinal);
        const id = `${key}/${ordinal}`;
        const role = attributes["data-consent-role"] ?? "shared component or inherited; see owner contract";
        const movedTimelineText = file === "components/consent/handshake-timeline.tsx" && tag === "span"
          && ['"status"', '"body"'].includes(attributes["data-consent-role"]);
        const before = movedTimelineText
          ? { role: "new span wrapper; the same text was previously rendered by its enclosing div", className: null }
          : baseline.get(id) ?? { role, className: attributes.className ?? null };
        elements.push({ id, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          control, text, visibleAttributes,
          handlers: Object.fromEntries(Object.entries(attributes).filter(([key]) => /^on[A-Z]/.test(key))),
          guards: Object.fromEntries(Object.entries(attributes).filter(([key]) => /^(?:disabled|busy|loading|checked|open|aria-pressed|aria-selected|type|href)$/.test(key))),
          conditions, before, role, className: attributes.className ?? null });
      }
    }
    // Copy maps and presenter strings stay projections, not fabricated controls.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && !ts.isImportDeclaration(node.parent) && !ts.isImportSpecifier(node.parent)
      && !ts.isJsxAttribute(node.parent) && !node.getText(ast).startsWith('"@/')) {
      const value = node.getText(ast);
      const classTokens = /(?:^|["'`\s])(?:text-|font-|flex\b|items-|gap-|p[xybtlr]?-|space-|grid\b|rounded-|bg-|border-|hover:|dark:|leading-|size-|min-|max-|w-|h-|sr-only)/;
      if (/[A-Za-z]{2} [A-Za-z]{2}/.test(value) && !classTokens.test(value)
        && !/(?:className|\.className)$/.test(node.parent.name?.getText(ast) ?? "")) copySources.push({ file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, projection: clean(value) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const report = {
  sourceState: "working tree based on sourceSha; baseline roles were captured before presentation edits",
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baselineSha: previous?.baselineSha ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  evidence: "Source enumeration. Runtime computed type, x/y, focus, scroll, mount and provider/native acceptance are not inferred from JSX. See consent.md for route/host, API and cancellation ownership. Conditions are lexical enclosing expressions; early returns and caller guards require the owning source.",
  exclusions: { "components/consent/status-bar.tsx": "Retained export; no mounted caller. No Details control is introduced.",
    "components/consent/notification-provider.tsx": "Mounted infrastructure, not a second inbox; copy is notification/push projection.",
    "provider/native": "Stripe, Google, OS notification, permission and native renderer controls are outside this JSX inventory." },
  counts: { files: files.length, elements: elements.length, controls: elements.filter(item => item.control).length, copySources: copySources.length },
  elements, copySources,
};
// One record per line keeps source review practical without treating a source
// fingerprint as behavior or visual acceptance.
const { elements: elementRows, copySources: copyRows, ...metadata } = report;
fs.writeFileSync(output, JSON.stringify(metadata, null, 2).slice(0, -1)
  + ',\n"elements":[\n' + elementRows.map(item => JSON.stringify(item)).join(',\n')
  + '\n],\n"copySources":[\n' + copyRows.map(item => JSON.stringify(item)).join(',\n') + '\n]}\n');
console.log(JSON.stringify(report.counts));
