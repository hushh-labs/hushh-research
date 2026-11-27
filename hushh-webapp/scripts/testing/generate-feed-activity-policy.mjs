import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.resolve(web, "../consent-protocol/contracts/feed/activity-policy.v1.json");
const target = path.join(web, "lib/feed/activity-policy.generated.json");
const content = fs.readFileSync(source, "utf8");
const policy = JSON.parse(content);
for (const [event, rule] of Object.entries(policy.events)) {
  if (!/^[a-z0-9_]+$/.test(event) || !Object.hasOwn(policy.agents, rule.agent) || !Object.hasOwn(policy.scopes, rule.scope)) throw new Error("Invalid authored Feed event scope: " + event);
  if (rule.search_terms && (!Array.isArray(rule.search_terms) || rule.search_terms.length > 12 || rule.search_terms.some(term => typeof term !== "string" || term.length > 80))) throw new Error("Unbounded authored Feed search labels: " + event);
}
for (const scope of Object.values(policy.classified_scopes)) if (!Object.hasOwn(policy.scopes, scope)) throw new Error("Invalid classified agent scope");
for (const scope of Object.values(policy.connector_scopes)) if (!Object.hasOwn(policy.scopes, scope)) throw new Error("Invalid connector scope");
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== content) throw new Error("Feed policy projection is stale");
} else fs.writeFileSync(target, content);
