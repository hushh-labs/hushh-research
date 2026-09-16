import { expect, it } from "vitest";
import { getKaiActionById, listKaiActions } from "@/lib/voice/kai-action-gateway";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { prepareCommandPeople } from "@/lib/one-location/command-preparation";

it("preserves the authored atomic backend binding in the client projection", () => {
  expect(
    getKaiActionById("location.create_circle")?.command?.backend_binding,
  ).toBe("location.create_circle");
  expect(getKaiActionById("location.create_circle")?.execution_policy).toBe("allow_direct");
});

it("covers generated Location capabilities with a prepared owner, backend binding or explicit screen", () => {
  const root = path.resolve(__dirname, "../..");
  const registered = new Map<string, boolean>();
  function scan(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(filename); continue; }
      if (!entry.name.endsWith(".tsx")) continue;
      const source = fs.readFileSync(filename, "utf8");
      if (!source.includes("useLocalOnboardingActionHandler")) continue;
      const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useLocalOnboardingActionHandler") {
          const [id, , options] = node.arguments;
          if (id && ts.isStringLiteral(id)) {
            const prepared = !!options && ts.isObjectLiteralExpression(options) && options.properties.some((property) =>
              property.name && ts.isIdentifier(property.name) && property.name.text === "prepare");
            registered.set(id.text, registered.get(id.text) === true || prepared);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  scan(path.join(root, "app")); scan(path.join(root, "components"));
  const missing: string[] = [];
  for (const action of listKaiActions().filter((entry) => entry.action_id.startsWith("location.") || entry.command?.domain === "location")) {
    if (action.execution_target.status === "wired" && action.execution_target.path === "voice_tool") continue;
    const route = action.command?.review_route;
    expect(route, action.action_id).toBeTruthy();
    const destination = new URL(route!, "https://example.test");
    expect(fs.existsSync(path.join(root, "app", destination.pathname, "page.tsx")), action.action_id).toBe(true);
    expect(destination.searchParams.get("action"), action.action_id).not.toBe("temp-link");
    if (action.command?.review_only || action.command?.backend_binding ||
      (action.execution_target.status === "wired" && action.execution_target.path === "route")) continue;
    if (!registered.get(action.action_id)) missing.push(action.action_id);
  }
  expect(missing).toEqual([]);
});
it("requires an exact choice for duplicate names and binds only that record", () => {
  const input = {
    owner: "owner",
    person: "Alex",
    people: [
      { id: "a", name: "Alex", ready: true },
      { id: "b", name: "Alex", ready: true },
    ],
    selectedIds: ["stale"],
  };
  expect(prepareCommandPeople(input)).toMatchObject({
    status: "blocked",
    choices: [{ id: "a" }, { id: "b" }],
  });
  expect(
    prepareCommandPeople({ ...input, chosenResourceId: "b" }),
  ).toMatchObject({ status: "ready", binding: { recipientIds: ["b"] } });
});
