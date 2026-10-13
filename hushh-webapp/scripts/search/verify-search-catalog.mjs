import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "../architecture/ui-source-index.mjs";

const WEBAPP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readStringArray(sourceFile, name) {
  let values;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name &&
        node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      values = node.initializer.elements.filter(ts.isStringLiteralLike).map(element => element.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!values) throw new Error(`Missing presentation policy ${name}.`);
  return values;
}

/** Check curated identifiers; generated action contracts retain discovery authority. */
export function verifySearchCatalog() {
  const filename = path.join(WEBAPP_ROOT, "lib/search/search-suggestions-catalog.ts");
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const gateway = JSON.parse(fs.readFileSync(path.join(WEBAPP_ROOT, "contracts/kai/kai-action-gateway.vnext.json"), "utf8"));
  const actions = new Map(gateway.actions.map(action => [action.action_id, action]));
  const idle = readStringArray(source, "IDLE_SUGGESTION_IDS");
  const excluded = readStringArray(source, "EXCLUDED_ACTION_IDS");
  const commands = readStringArray(source, "NAV_LIKE_KAI_COMMAND_IDS");
  const errors = [];
  for (const ids of [idle, excluded, commands]) {
    if (new Set(ids).size !== ids.length) errors.push("Duplicate curated action identifier.");
    for (const id of ids) if (!actions.has(id)) errors.push(`Unknown curated action: ${id}`);
  }
  for (const id of [...idle, ...commands]) {
    const action = actions.get(id);
    if (excluded.includes(id)) errors.push(`Excluded action is curated: ${id}`);
    if (action && action.execution_target.status !== "wired") errors.push(`Curated action is unwired: ${id}`);
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "SEARCH_CATALOG" &&
        node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      errors.push("Search semantics must project generated actions, not copy a separate catalog.");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const error of errors) console.error(`FAIL: ${error}`);
  if (!errors.length) console.log(`Search presentation: ${idle.length} idle actions; generated contracts own labels, discovery and guards.`);
  return errors.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = verifySearchCatalog() ? 0 : 1;
}
