import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "../architecture/ui-source-index.mjs";

const __filename = fileURLToPath(import.meta.url);
const WEBAPP_ROOT = path.resolve(path.dirname(__filename), "../..");
const CATALOG_PATH = path.join(WEBAPP_ROOT, "lib/search/search-suggestions-catalog.ts");
const GATEWAY_PATH = path.join(WEBAPP_ROOT, "contracts/kai/kai-action-gateway.vnext.json");

/**
 * A `kai_command`-executed destination is still a plain "go here" to the
 * person using it, same as a `route`-typed action -- the difference is only
 * in how the runtime dispatches it, something Search's catalog deliberately
 * does not need to know. Named here, once, instead of re-deriving it from
 * gateway internals this script otherwise never reads for anything but ids.
 */
const NAV_LIKE_KAI_COMMAND_IDS = new Set([
  "route.profile",
  "route.consents",
  "route.analysis_history",
  "route.kai_import",
]);

function readStringArrayLiteral(sourceFile, constName) {
  let values = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sourceFile) === constName &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      values = node.initializer.elements
        .filter(ts.isStringLiteralLike)
        .map((element) => element.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!values) throw new Error(`Could not find a string array literal named ${constName} in the catalog.`);
  return values;
}

function readCatalogActionIds(sourceFile) {
  let ids = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sourceFile) === "SEARCH_CATALOG" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      ids = node.initializer.elements
        .filter(ts.isObjectLiteralExpression)
        .map((entry) => {
          const prop = entry.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(sourceFile) === "actionId",
          );
          if (!prop || !ts.isStringLiteralLike(prop.initializer)) return null;
          return prop.initializer.text;
        })
        .filter((id) => id !== null);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!ids) throw new Error("Could not find the SEARCH_CATALOG array literal in the catalog.");
  return ids;
}

/** Same rule as `isOfferableInSearch` for route-typed actions, duplicated here on purpose: this script reads the gateway as inert JSON data, never as gateway code. */
function isNavigableRoute(action) {
  const target = action.execution_target;
  return target.status === "wired" && target.path === "route";
}

export function verifySearchCatalog() {
  const catalogText = fs.readFileSync(CATALOG_PATH, "utf8");
  const sourceFile = ts.createSourceFile(CATALOG_PATH, catalogText, ts.ScriptTarget.Latest, true);
  const idleIds = readStringArrayLiteral(sourceFile, "IDLE_SUGGESTION_IDS");
  const catalogIds = readCatalogActionIds(sourceFile);
  const excludedIds = readStringArrayLiteral(sourceFile, "EXCLUDED_ACTION_IDS");
  const catalogIdSet = new Set(catalogIds);
  const triagedIdSet = new Set([...catalogIds, ...excludedIds]);

  const gateway = JSON.parse(fs.readFileSync(GATEWAY_PATH, "utf8"));
  const gatewayIdSet = new Set(gateway.actions.map((action) => action.action_id));

  const errors = [];

  const orphanedIdle = idleIds.filter((id) => !catalogIdSet.has(id));
  if (orphanedIdle.length) {
    errors.push(`IDLE_SUGGESTION_IDS references ids missing from SEARCH_CATALOG itself: ${orphanedIdle.join(", ")}`);
  }

  const deadCatalogEntries = catalogIds.filter((id) => !gatewayIdSet.has(id));
  if (deadCatalogEntries.length) {
    errors.push(
      `SEARCH_CATALOG references action_ids the generated gateway no longer has (renamed or retired -- update or remove these entries in lib/search/search-suggestions-catalog.ts): ${deadCatalogEntries.join(", ")}`,
    );
  }

  if (errors.length) {
    for (const message of errors) console.error(`FAIL: ${message}`);
    return false;
  }

  const untriaged = gateway.actions
    .filter((action) => (isNavigableRoute(action) || NAV_LIKE_KAI_COMMAND_IDS.has(action.action_id)) && !triagedIdSet.has(action.action_id))
    .map((action) => action.action_id)
    .sort();

  if (untriaged.length) {
    console.error(
      `FAIL: a new page/action added ${untriaged.length} reachable destination(s) the search catalog has not triaged yet:`,
    );
    for (const id of untriaged) console.error(`  - ${id}`);
    console.error(
      "Add each to SEARCH_CATALOG (and IDLE_SUGGESTION_IDS if it belongs in the idle row) in lib/search/search-suggestions-catalog.ts, or add it to EXCLUDED_ACTION_IDS with a one-line reason if it should not be searchable.",
    );
    return false;
  }

  console.log(`Search catalog: ${catalogIds.length} entries (${idleIds.length} idle), all resolve against the generated gateway.`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = verifySearchCatalog() ? 0 : 1;
}
