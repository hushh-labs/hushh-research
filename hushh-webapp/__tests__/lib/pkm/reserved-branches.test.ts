// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import gateway from "@/contracts/kai/kai-action-gateway.vnext.json";
import routeIndex from "@/contracts/kai/one-route-orchestration-index.v1.json";
import contract from "@/contracts/pkm/reserved-branches.v1.json";
import {
  RESERVED_ENFORCEMENT_MODE,
  RESERVED_MEMORY_SCREEN_POLICY,
  ReservedBranchWriteBlocked,
  assertReservedBranchesUntouched,
  evaluateReservedWrite,
  isReservedPath,
  isReservedRefusalHint,
  reservedEntryFor,
  touchedReservedBranches,
  writer,
} from "@/lib/pkm/reserved-branches";
import { buildGmailWorkspaceRoute, gmailDeepLinkWorkspace } from "@/lib/navigation/routes";

/**
 * `contracts/pkm/reserved-branches.v1.json` decides which PKM branches belong to
 * an app feature and which writers may change them. Phase 0 only counts what it
 * WOULD refuse, so the contract has to be right before anything enforces it:
 * every writer label in code catalogued, every copy identical, every offer
 * pointing at a real screen.
 */

const WEB_ROOT = process.cwd();
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const CONTRACT_FILE = path.join("contracts", "pkm", "reserved-branches.v1.json");

const writerIds = Object.keys(contract.writers).filter((key) => !key.startsWith("$"));

describe("reserved-branch contract packaging", () => {
  it("keeps all three copies byte-for-byte identical", () => {
    const canonical = fs.readFileSync(path.join(REPO_ROOT, CONTRACT_FILE));
    for (const mirror of [
      path.join(WEB_ROOT, CONTRACT_FILE),
      path.join(REPO_ROOT, "consent-protocol", CONTRACT_FILE),
    ]) {
      expect(fs.readFileSync(mirror).equals(canonical), mirror).toBe(true);
    }
  });

  it("only names catalogued writers on its entries", () => {
    for (const entry of contract.entries) {
      for (const writerId of entry.writer_ids) {
        expect(writerIds, `${entry.domain}.${entry.branch_prefix}`).toContain(writerId);
      }
    }
  });

  it("offers only routes and actions the generated contracts define", () => {
    expect(offerRouteProblems(contract.entries)).toEqual([]);
  });

  it("opens identity facts on Mail's KYC tab, a tab the Mail page opens from the link", () => {
    for (const [domain, branch] of [
      ["identity", "identity_profile"],
      ["identity", "identity_documents"],
      ["professional", "profile"],
    ] as const) {
      const entry = contract.entries.find((item) => item.domain === domain && item.branch_prefix === branch);
      expect(entry?.offer_action, `${domain}.${branch}`).toMatchObject({
        route_pattern: buildGmailWorkspaceRoute("kyc"),
        action_id: "route.one_gmail_kyc",
      });
    }
    const [routePath, query] = buildGmailWorkspaceRoute("kyc").split("?");
    expect(routePath).toBe("/one/gmail");
    expect(gmailDeepLinkWorkspace(new URLSearchParams(query).get("workspace"))).toBe("kyc");
  });

  it("refuses an offer to a route nobody declares (negative control)", () => {
    const forged = [
      // A query-qualified path the gateway does not declare.
      { domain: "identity", branch_prefix: "x", offer_action: { route_pattern: "/one/gmail?workspace=private", action_id: "route.one_gmail_kyc" } },
      // A real action, pointed somewhere it does not go.
      { domain: "identity", branch_prefix: "y", offer_action: { route_pattern: "/one/gmail?workspace=receipts", action_id: "route.one_gmail_kyc" } },
      // A path the route index does not know.
      { domain: "identity", branch_prefix: "z", offer_action: { route_pattern: "/one/kyc", action_id: "route.one_gmail_kyc" } },
    ];
    expect(offerRouteProblems(forged)).toHaveLength(3);
  });
});

type GatewayAction = {
  action_id: string;
  reachability?: { routes?: string[]; screens?: string[] };
  execution_target?: { status?: string; path?: string; target?: string };
};

/**
 * Every offer must open a route the generated contracts define, through a wired
 * route action that goes exactly there. A query-qualified route (a tab of one
 * page) is in the route index only when its query changes the page's screen;
 * a tab on the same screen is deliberately left to its path's entry. Such an
 * offer is accepted only when its path is indexed, the gateway action declares
 * that exact route, and the action's screen is the path's own screen.
 */
function offerRouteProblems(
  entries: ReadonlyArray<{ domain: string; branch_prefix: string; offer_action?: unknown }>,
): string[] {
  const routes = new Map(routeIndex.routes.map((route) => [route.route_pattern, route]));
  const actions = new Map((gateway.actions as GatewayAction[]).map((action) => [action.action_id, action]));
  const problems: string[] = [];
  for (const entry of entries) {
    const offer = entry.offer_action as { route_pattern: string; action_id: string } | null | undefined;
    if (!offer) continue;
    const where = `${entry.domain}.${entry.branch_prefix} -> ${offer.route_pattern}`;
    const action = actions.get(offer.action_id);
    if (!action) {
      problems.push(`${where}: no action ${offer.action_id}`);
      continue;
    }
    if (action.execution_target?.path === "route" && action.execution_target.target !== offer.route_pattern) {
      problems.push(`${where}: ${offer.action_id} goes to ${action.execution_target.target}`);
      continue;
    }
    if (routes.has(offer.route_pattern)) continue;
    const [routePath, query] = offer.route_pattern.split("?");
    const base = routes.get(routePath!);
    const sameScreenTab =
      Boolean(query) &&
      Boolean(base) &&
      action.execution_target?.status === "wired" &&
      action.execution_target?.path === "route" &&
      (action.reachability?.routes ?? []).includes(offer.route_pattern) &&
      (action.reachability?.screens ?? []).length === 1 &&
      action.reachability!.screens![0] === base!.canonical_screen;
    if (!sameScreenTab) problems.push(`${where}: not a route the index or the gateway defines`);
  }
  return problems;
}

describe("reserved-branch loader", () => {
  it("reserves a wildcard domain apart from its except branch", () => {
    expect(reservedEntryFor("financial", "portfolio.holdings")?.ownerFeature).toBe("finance");
    expect(reservedEntryFor("financial", "")?.ownerFeature).toBe("finance");
    expect(reservedEntryFor("financial", "agent_memory")).toBeNull();
    expect(reservedEntryFor("financial", "agent_memory.entities.mem_1")).toBeNull();
  });

  it("matches a prefix on a segment boundary, never a substring", () => {
    expect(isReservedPath("location", "saved_places")).toBe(true);
    expect(isReservedPath("location", "Saved_Places.home.label")).toBe(true);
    expect(isReservedPath("location", "saved_places_archive")).toBe(false);
    expect(isReservedPath("location", "agent_memory")).toBe(false);
    expect(isReservedPath("food", "preferences")).toBe(false);
  });

  it("refuses an unknown writer and a memory agent, and allows a listed feature", () => {
    expect(writer("not_a_registered_writer")).toBeNull();
    const paths = ["saved_places.home"];
    expect(evaluateReservedWrite({ domain: "location", paths, writerId: "not_a_registered_writer" })).toEqual([
      { domain: "location", branch: "saved_places", writerId: "not_a_registered_writer", reason: "writer_unknown" },
    ]);
    expect(evaluateReservedWrite({ domain: "location", paths, writerId: "agent_chat_owner_request" })[0]?.reason).toBe(
      "memory_agent",
    );
    expect(evaluateReservedWrite({ domain: "location", paths, writerId: "kai_dashboard_portfolio_save" })[0]?.reason).toBe(
      "writer_not_listed",
    );
    expect(evaluateReservedWrite({ domain: "location", paths, writerId: "one_location_saved_place_confirm" })).toEqual([]);
  });

  it("refuses auto-save authority and a missing capability, as the server does", () => {
    const paths = ["saved_places"];
    expect(
      evaluateReservedWrite({
        domain: "location",
        paths,
        writerId: "one_location_saved_place_confirm",
        authorizationMode: "owner_auto_save_policy",
      })[0]?.reason,
    ).toBe("auto_save_mode");
    expect(
      evaluateReservedWrite({ domain: "location", paths, writerId: "location_onboarding_command" })[0]?.reason,
    ).toBe("capability_missing");
    expect(
      evaluateReservedWrite({
        domain: "location",
        paths,
        writerId: "location_onboarding_command",
        capabilities: ["location_finalize_authorization"],
      }),
    ).toEqual([]);
    expect(
      evaluateReservedWrite({
        domain: "identity",
        paths: ["identity_documents"],
        writerId: "agent_chat_kyc_owner_confirmed",
      })[0]?.reason,
    ).toBe("capability_missing");
  });

  it("enforces since the migration release, with read-only reserved Memory items, from the contract", () => {
    // Rollback is the contract's `enforcement` value back to `shadow`.
    expect(RESERVED_ENFORCEMENT_MODE).toBe("enforce");
    expect(RESERVED_MEMORY_SCREEN_POLICY).toBe("read_only_reserved");
  });

  it("lets every listed writer write its own entries (the whole inventory, replayed)", () => {
    let replayed = 0;
    for (const raw of contract.entries as Array<{ domain: string; branch_prefix: string; writer_ids: string[] }>) {
      const branch = raw.branch_prefix !== "*" ? raw.branch_prefix : raw.domain === "financial" ? "profile" : "items";
      for (const writerId of raw.writer_ids) {
        const catalogued = writer(writerId);
        expect(catalogued, writerId).not.toBeNull();
        for (const mode of catalogued!.authorizationModes) {
          expect(
            evaluateReservedWrite({
              domain: raw.domain,
              paths: [branch, `${branch}.detail`],
              writerId,
              authorizationMode: mode,
              capabilities: catalogued!.requiresCapability ? [catalogued!.requiresCapability] : [],
            }),
            `${raw.domain}.${branch} ${writerId} ${mode}`,
          ).toEqual([]);
          replayed += 1;
        }
      }
    }
    expect(replayed).toBeGreaterThan(40);
  });

  it("throws only in enforce mode, and only on a refused change", () => {
    const params = {
      domain: "identity",
      before: { identity_documents: { passport_number: "A1" } },
      after: { identity_documents: { passport_number: "B2" } },
      writerId: "agent_chat_owner_request",
    };
    expect(assertReservedBranchesUntouched({ ...params, mode: "shadow" })).toHaveLength(1);
    expect(() => assertReservedBranchesUntouched({ ...params, mode: "enforce" })).toThrow(ReservedBranchWriteBlocked);
    expect(
      assertReservedBranchesUntouched({ ...params, after: params.before, mode: "enforce" }),
    ).toEqual([]);
  });

  it("treats a re-route into the sibling as saveable, every other reserved hint as a refusal", () => {
    expect(isReservedRefusalHint("reserved_target_rerouted_to_sibling")).toBe(false);
    expect(isReservedRefusalHint("reserved_branch_blocked")).toBe(true);
    expect(isReservedRefusalHint("invalid_or_reserved_target_rejected")).toBe(true);
    expect(isReservedRefusalHint("reserved_target_offered_not_saved")).toBe(true);
  });

  it("never refuses the upgrade gate, and ignores non-reserved paths", () => {
    expect(evaluateReservedWrite({ domain: "wallet", paths: ["summary"], writerId: "pkm_upgrade_orchestrator" })).toEqual([]);
    expect(evaluateReservedWrite({ domain: "financial", paths: ["agent_memory"], writerId: "agent_chat_owner_request" })).toEqual([]);
  });
});

describe("device-side reserved diff", () => {
  it("catches an identity_documents change smuggled behind an agent_memory scope", () => {
    const touched = touchedReservedBranches({
      domain: "identity",
      before: { identity_documents: { passport_number: "A1" }, agent_memory: {} },
      after: {
        agent_memory: { entities: { mem_1: { summary: "Prefers email" } } },
        identity_documents: { passport_number: "B2" },
      },
    });
    expect(touched).toEqual(["identity_documents"]);
    expect(evaluateReservedWrite({ domain: "identity", paths: touched, writerId: "agent_chat_owner_request" })).toEqual([
      { domain: "identity", branch: "identity_documents", writerId: "agent_chat_owner_request", reason: "memory_agent" },
    ]);
  });

  it("does not count an unchanged reserved branch or bookkeeping keys", () => {
    expect(
      touchedReservedBranches({
        domain: "financial",
        before: { updated_at: "1", domain_intent: { source: "a" }, portfolio: { holdings: [1] } },
        after: {
          updated_at: "2",
          domain_intent: { source: "b" },
          portfolio: { holdings: [1] },
          agent_memory: { entities: {} },
        },
      }),
    ).toEqual([]);
  });

  it("counts a branch dropped by replace_domain and one targeted by delete_entity", () => {
    const before = { saved_places: { home: {} }, visit_notes: { cafe: {} } };
    expect(
      touchedReservedBranches({ domain: "location", before, after: { visit_notes: { cafe: {} } }, mergeMode: "replace_domain" }),
    ).toEqual(["saved_places"]);
    expect(
      touchedReservedBranches({
        domain: "location",
        before,
        after: {},
        mergeMode: "delete_entity",
        deleteTargetPath: "visit_notes.entities.cafe",
      }),
    ).toEqual(["visit_notes"]);
  });
});

/* ---------- writer inventory ---------- */

type SourceFile = { file: string; text: string };
type Inventory = { labels: Map<string, string[]>; templates: Array<{ pattern: RegExp; site: string }>; unresolved: string[] };

function propertyNamed(node: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return node.properties.find((property) => property.name && ts.isIdentifier(property.name) && property.name.text === name);
}

function stringInitializer(initializer: ts.Expression | undefined): string | null {
  if (!initializer) return null;
  // `"label" as const` and `"label" satisfies Writer` are still the label.
  if (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
    return stringInitializer(initializer.expression);
  }
  return ts.isStringLiteralLike(initializer) ? initializer.text : null;
}

function topLevelStringConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = stringInitializer(declaration.initializer);
      if (ts.isIdentifier(declaration.name) && value !== null) {
        constants.set(declaration.name.text, value);
      }
    }
  }
  return constants;
}

/** The repo-relative module an import specifier names, among the scanned files. */
function resolveModule(importer: string, specifier: string, files: ReadonlyMap<string, ts.SourceFile>): ts.SourceFile | null {
  const base = specifier.startsWith("@/")
    ? path.posix.join("hushh-webapp", specifier.slice(2))
    : specifier.startsWith(".")
      ? path.posix.join(path.posix.dirname(importer.split(path.sep).join("/")), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const found = files.get(candidate);
    if (found) return found;
  }
  return null;
}

/** A string constant imported by name (`import { SOURCE } from "@/lib/x"`), if any. */
function importedStringConstant(
  sourceFile: ts.SourceFile,
  name: string,
  files: ReadonlyMap<string, ts.SourceFile>,
): string | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text !== name) continue;
      const exported = element.propertyName?.text ?? element.name.text;
      const target = resolveModule(sourceFile.fileName, statement.moduleSpecifier.text, files);
      return target ? topLevelStringConstants(target).get(exported) ?? null : null;
    }
  }
  return null;
}

/** The name callers use for the function that forwards `node`'s value. */
function enclosingFunctionName(node: ts.Node): string | null {
  for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
    if ((ts.isFunctionDeclaration(cursor) || ts.isMethodDeclaration(cursor)) && cursor.name && ts.isIdentifier(cursor.name)) {
      return cursor.name.text;
    }
    if (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) {
      // `const f = () => ...` or a wrapped `const f = useCallback(() => ...)`.
      // A plain `const result = await call(...)` is not a function and must
      // not be mistaken for one, or its callers would never be scanned.
      const holder = ts.isCallExpression(cursor.parent) ? cursor.parent.parent : cursor.parent;
      if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
      return null;
    }
  }
  return null;
}

function parse(source: SourceFile): ts.SourceFile {
  const kind = source.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Every writer label a PKM write authorization can carry. An authorization is
 * any object literal with `confirmedByUser` or `authorizationMode`; its `source`
 * is the writer id. A `source` forwarded from a parameter is resolved at the
 * forwarding function's call sites, so a new caller with a new label is caught.
 */
function collectWriterLabels(sources: SourceFile[]): Inventory {
  const inventory: Inventory = { labels: new Map(), templates: [], unresolved: [] };
  const forwarders = new Set<string>();
  const add = (label: string, site: string) => inventory.labels.set(label, [...(inventory.labels.get(label) ?? []), site]);

  const resolve = (expression: ts.Expression, sourceFile: ts.SourceFile, site: string, allowForward: boolean): void => {
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
      resolve(expression.expression, sourceFile, site, allowForward);
    } else if (ts.isStringLiteralLike(expression)) {
      add(expression.text, site);
    } else if (ts.isConditionalExpression(expression)) {
      resolve(expression.whenTrue, sourceFile, site, allowForward);
      resolve(expression.whenFalse, sourceFile, site, allowForward);
    } else if (ts.isTemplateExpression(expression)) {
      const parts = [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)];
      const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      inventory.templates.push({ pattern: new RegExp(`^${escaped.join(".+")}$`), site });
    } else if (ts.isIdentifier(expression) && topLevelStringConstants(sourceFile).has(expression.text)) {
      add(topLevelStringConstants(sourceFile).get(expression.text)!, site);
    } else if (ts.isIdentifier(expression) && importedStringConstant(sourceFile, expression.text, files) !== null) {
      add(importedStringConstant(sourceFile, expression.text, files)!, site);
    } else {
      const forwarder = allowForward ? enclosingFunctionName(expression) : null;
      if (forwarder) forwarders.add(forwarder);
      else inventory.unresolved.push(`${site} ${expression.getText(sourceFile)}`);
    }
  };

  const parsed = sources.map((source) => ({ source, sourceFile: parse(source) }));
  const files = new Map(parsed.map(({ source, sourceFile }) => [source.file.split(path.sep).join("/"), sourceFile]));
  for (const { source, sourceFile } of parsed) {
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && (propertyNamed(node, "confirmedByUser") || propertyNamed(node, "authorizationMode"))) {
        const property = propertyNamed(node, "source");
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (property && ts.isPropertyAssignment(property)) {
          resolve(property.initializer, sourceFile, `${source.file}:${line}`, true);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const { source, sourceFile } of parsed) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        if (name && forwarders.has(name)) {
          for (const argument of node.arguments) {
            if (!ts.isObjectLiteralExpression(argument)) continue;
            const property = propertyNamed(argument, "source");
            const line = sourceFile.getLineAndCharacterOfPosition(argument.getStart()).line + 1;
            if (property && ts.isPropertyAssignment(property)) {
              resolve(property.initializer, sourceFile, `${source.file}:${line} via ${name}`, false);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return inventory;
}

function missingWriters(inventory: Inventory, catalogued: readonly string[]): string[] {
  const known = new Set(catalogued);
  const missing = [...inventory.labels.keys()].filter((label) => !known.has(label));
  for (const template of inventory.templates) {
    if (!catalogued.some((writerId) => template.pattern.test(writerId))) missing.push(`${template.pattern} (${template.site})`);
  }
  return missing.sort();
}

function readSources(root: string, directories: string[], extension: RegExp): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "__tests__", ".next", "out", "vendor", "tests"].includes(entry.name)) continue;
        walk(full);
      } else if (extension.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$/.test(entry.name)) {
        files.push({ file: path.relative(REPO_ROOT, full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  for (const directory of directories) {
    const full = path.join(root, directory);
    if (fs.existsSync(full)) walk(full);
  }
  return files;
}

describe("reserved-branch writer inventory", () => {
  const webSources = readSources(WEB_ROOT, ["app", "components", "hooks", "lib"], /\.tsx?$/);
  const inventory = collectWriterLabels(webSources);

  it("finds the writers it is meant to find", () => {
    // An inventory that silently found nothing would pass every check below.
    expect(inventory.labels.size).toBeGreaterThan(40);
    expect(inventory.labels.has("one_wallet_add")).toBe(true); // forwarded through WalletService.addCard
    expect(inventory.labels.has("portfolio_source_change")).toBe(true); // forwarded through a useCallback
    expect(inventory.labels.has("one_location_saved_place_confirm")).toBe(true); // a module function
    expect(inventory.labels.has("drive_read_review")).toBe(true); // forwarded through an exported function
    expect(inventory.labels.has("first_connect_insights")).toBe(true); // a same-file constant
    expect(inventory.labels.has("plaid_vault_view_upgrade")).toBe(true); // a conditional
    expect(inventory.templates.length).toBeGreaterThan(0);
  });

  it("resolves every forwarded writer label", () => {
    expect(inventory.unresolved).toEqual([]);
  });

  it("catalogues every writer label used in code", () => {
    expect(missingWriters(inventory, writerIds)).toEqual([]);
  });

  it("fails on a new writer label that has no registry entry (negative control)", () => {
    const fixture = collectWriterLabels([
      {
        file: "fixture/new-writer.ts",
        text: `
          export function forward(params: { source: string }) {
            return save({ confirmation: { confirmedByUser: true, surface: "web", source: params.source } });
          }
          forward({ source: "brand_new_forwarded_writer" });
          save({ confirmation: { confirmedByUser: true, surface: "web", source: "brand_new_unregistered_writer" } });
          save({ confirmation: { confirmedByUser: true, surface: "web", source: "one_wallet_add" } });
        `,
      },
    ]);
    expect(missingWriters(fixture, writerIds)).toEqual(["brand_new_forwarded_writer", "brand_new_unregistered_writer"]);
  });

  it("follows a writer label imported as an `as const` constant", () => {
    // The Settings style writer passes OWNER_STYLE_SETTINGS_SOURCE, declared
    // `as const` in another module. Before this resolver followed imports,
    // that label was reported unresolved instead of checked.
    const fixture = collectWriterLabels([
      {
        file: "hushh-webapp/lib/fixture/style-source.ts",
        text: `export const STYLE_SOURCE = "brand_new_imported_writer" as const;`,
      },
      {
        file: "hushh-webapp/lib/fixture/style-writer.ts",
        text: `
          import { STYLE_SOURCE as SOURCE } from "@/lib/fixture/style-source";
          save({ confirmation: { confirmedByUser: true, surface: "web", source: SOURCE } });
        `,
      },
    ]);
    expect(fixture.unresolved).toEqual([]);
    expect(missingWriters(fixture, writerIds)).toEqual(["brand_new_imported_writer"]);
  });

  /**
   * Writers catalogued ahead of the code that produces them, because that code
   * is on a sibling lane that has not been integrated yet. Each entry names its
   * lane. The second test below fails once the code is present, so an entry
   * cannot outlive its reason: delete it in the integration that brings the code.
   */
  const AWAITING_SIBLING_LANE: Readonly<Record<string, string>> = {};

  const producedByCode = (corpus: string) => (writerId: string) =>
    inventory.labels.has(writerId) ||
    inventory.templates.some((template) => template.pattern.test(writerId)) ||
    corpus.includes(`"${writerId}"`);

  const pythonSources = readSources(path.join(REPO_ROOT, "consent-protocol"), ["hushh_mcp", "api"], /\.py$/);
  const corpus = [...webSources, ...pythonSources].map((source) => source.text).join("\n");

  it("keeps no catalogued writer that no code can produce", () => {
    const stale = writerIds.filter(
      (writerId) => !(writerId in AWAITING_SIBLING_LANE) && !producedByCode(corpus)(writerId),
    );
    expect(stale).toEqual([]);
  });

  it("drops an awaiting-lane writer as soon as its code is integrated", () => {
    const arrived = Object.keys(AWAITING_SIBLING_LANE).filter(producedByCode(corpus));
    expect(arrived, "remove these from AWAITING_SIBLING_LANE: their code is now present").toEqual([]);
    for (const writerId of Object.keys(AWAITING_SIBLING_LANE)) expect(writerIds).toContain(writerId);
  });
});
