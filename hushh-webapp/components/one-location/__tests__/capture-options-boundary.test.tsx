/**
 * Latency and freshness contracts for the One Location surface.
 *
 * Every assertion here was written after a real defect, and each one guards a
 * property that a type signature cannot:
 *
 * 1. Capture options must SURVIVE the prop boundary. The nearby check-in
 *    confirmation asks for a genuinely fresh fix with `{ maxAgeMs: 0 }`, but
 *    the function supplying that prop was declared with ZERO parameters.
 *    TypeScript permits the narrower arity — a function may always ignore its
 *    arguments — so it compiled clean, linted clean, passed every test, and
 *    silently discarded the option. The persisted radius anchor could be 20s
 *    stale while a comment three lines above promised it was fresh.
 *
 * 2. A mutating CTA must not hold its spinner across a full state reload. That
 *    round trip is bookkeeping the user is not waiting on, and it was most of
 *    what "every click takes seconds" meant.
 *
 * 3. Sharing must fan out concurrently, but BOUNDED — each grant costs two
 *    pooled database connections server-side.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

function parse(relativePath: string) {
  return ts.createSourceFile(relativePath, read(relativePath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function nodes<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node) {
    if (matches(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}

function captureCallback(name: string) {
  const declaration = nodes(parse("components/one-location/location-immersive-map.tsx"), ts.isVariableDeclaration)
    .find(node => ts.isIdentifier(node.name) && node.name.text === name);
  const initializer = declaration?.initializer;
  expect(initializer && ts.isCallExpression(initializer)).toBeTruthy();
  const callback = (initializer as ts.CallExpression).arguments[0]!;
  expect(ts.isArrowFunction(callback)).toBe(true);
  return callback as ts.ArrowFunction;
}

function optionBranches(expression: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(expression)) return optionBranches(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return [...optionBranches(expression.whenTrue), ...optionBranches(expression.whenFalse)];
  }
  return [expression];
}

describe("One Location capture-options boundary", () => {
  it("the map's capture forwarders declare and pass their options", () => {
    for (const [name, target] of [
      ["captureCurrentLocation", "OneLocationService.captureCurrentPosition"],
      ["captureAndRememberCurrentLocation", "captureCurrentLocation"],
    ]) {
      const callback = captureCallback(name!);
      // TypeScript permits dropping this argument; require the actual binding
      // to reach the next owner without fixing a formatting or field count.
      expect(callback.parameters.length).toBeGreaterThan(0);
      const binding = callback.parameters[0]!.name.getText();
      const forwarded = nodes(callback, ts.isCallExpression)
        .find(call => call.expression.getText().replace(/\s/g, "") === target);
      expect(forwarded?.arguments[0]?.getText()).toBe(binding);
    }
  });

  it("bypasses in-flight capture for freshness and measurement requirements", () => {
    const source = read("components/one-location/location-immersive-map.tsx");

    // Deduplication is right for cached-eligible callers and wrong for a
    // check-in anchor that must describe where the user is standing now.
    expect(source).toContain(
      "options?.maxAgeMs !== 0 &&\n        !options?.fresh &&\n        !options?.requireMeasurement",
    );
  });

  it("manual and command check-in both request a current measured fix", () => {
    const source = parse("components/one-location/nearby-check-in/nearby-check-in-sheet.tsx");
    const captures = nodes(source, ts.isCallExpression)
      .filter(call => call.expression.getText() === "captureCurrentPosition" && call.arguments.length > 0);
    expect(captures).toHaveLength(2);
    for (const capture of captures) {
      for (const branch of optionBranches(capture.arguments[0]!)) {
        expect(ts.isObjectLiteralExpression(branch)).toBe(true);
        const options = new Map((branch as ts.ObjectLiteralExpression).properties
          .filter(ts.isPropertyAssignment).map(property => [property.name.getText(), property.initializer.getText()]));
        expect(options.get("requireMeasurement")).toBe("true");
        expect(options.get("fresh") === "true" || options.get("maxAgeMs") === "0").toBe(true);
      }
    }
  });

  it("the check-in sheet's prop type accepts options at all", () => {
    const source = parse("components/one-location/nearby-check-in/nearby-check-in-sheet.tsx");
    const prop = nodes(source, ts.isPropertySignature).find(node => node.name.getText() === "captureCurrentPosition");
    expect(prop?.type && ts.isFunctionTypeNode(prop.type)).toBeTruthy();
    const parameter = (prop!.type as ts.FunctionTypeNode).parameters[0];
    expect(parameter).toBeDefined();
    expect(parameter?.type && ts.isTypeLiteralNode(parameter.type)).toBeTruthy();
    const fields = (parameter!.type as ts.TypeLiteralNode).members.map(member => member.name?.getText());
    expect(fields).toEqual(expect.arrayContaining(["maxAgeMs", "fresh", "requireMeasurement"]));
  });
});

describe("One Location CTA latency contract", () => {
  const page = () => read("app/one/location/page.tsx");

  it("no mutating CTA awaits a full state reload before releasing its spinner", () => {
    // `await refresh()` inside a handler adds a whole round trip to perceived
    // latency after the work is already done and toasted.
    expect(page()).not.toContain("await refresh();");
  });

  it("backgrounded reloads still swallow their own failure", () => {
    // A bare `void refresh()` would surface as an unhandled rejection, and a
    // reload that failed after a successful revoke used to be reported to the
    // user as "Could not revoke access" — blaming the operation that worked.
    const source = page();
    const backgrounded = source.match(/void refresh\(\)/g) ?? [];
    const handled = source.match(/void refresh\(\)\s*\.catch\(/g) ?? [];
    expect(backgrounded.length).toBeGreaterThan(0);
    expect(handled.length).toBe(backgrounded.length);
  });

  it("sharing fans out concurrently rather than one recipient at a time", () => {
    const source = page();
    expect(source).toContain("ONE_LOCATION_SHARE_CONCURRENCY");
    // The sequential shape this replaced.
    expect(source).not.toContain(
      "for (const recipient of shareReadySelectedRecipients) {",
    );
  });

  it("share fan-out stays bounded so it cannot exhaust the connection pool", () => {
    const source = page();
    const match = source.match(/ONE_LOCATION_SHARE_CONCURRENCY = (\d+)/);
    expect(match).toBeTruthy();
    const limit = Number(match?.[1]);
    expect(limit).toBeGreaterThan(1); // otherwise it is still sequential
    expect(limit).toBeLessThanOrEqual(8); // each grant costs 2 DB connections
    expect(source).toContain(
      "Math.min(ONE_LOCATION_SHARE_CONCURRENCY, pending.length)",
    );
  });

  it("both live-publish loops isolate failures per recipient", () => {
    const source = page();
    // One recipient throwing must not starve the others — with stable grant
    // ordering, a shared catch starved everyone after the failure on EVERY tick.
    expect(source).not.toContain("for (const grant of activeOwnerGrants) {");
    expect(source).toContain("activeOwnerGrants.map(async (grant) => {");
  });

  it("the review queue warms the position before Approve is pressed", () => {
    const source = page();
    expect(source).toContain(
      "void OneLocationService.captureCurrentPosition().catch(() => null);",
    );
    // Never outside a granted permission: an ungated capture would spend the
    // single system prompt iOS grants at a moment the user cannot explain.
    expect(source).toContain('if (permission?.state !== "granted") return;');
  });

  it("live publishing never serves a recipient a remembered fix", () => {
    const source = page();
    // The rule is unchanged; its evidence moved. Forcing an acquisition per
    // tick used to be how the publisher stayed current, and it stopped being
    // that once a continuous watch fed the shared store: the one-shot raced
    // the watch for the device and reported a location failure every time it
    // lost. Reading the store is both fresher and quieter, and
    // publishPointFrom is a stronger guarantee than an age ever was — it
    // rejects anything not measured this session, by provenance rather than
    // by clock.
    expect(source).toContain("const point = await liveHeartbeatPoint();");
    expect(source).toContain("return publishPointFrom(LocationBus.getState());");
    expect(source).not.toContain(
      "const point = await OneLocationService.captureCurrentPosition({\n          maxAgeMs: 0,\n        });",
    );
  });

  it("the heartbeat's reuse window is one tick, not a hand-picked number", () => {
    const source = page();
    // A recipient calls a share stale at three publish periods, so a ceiling
    // of one period keeps the published point inside the window the receiving
    // side is already written against.
    expect(source).toContain(
      "const LIVE_HEARTBEAT_MAX_AGE_MS = LIVE_LOCATION_UPDATE_INTERVAL_MS;",
    );
  });

  it("a publish failure is reported only when the owner can act on it", () => {
    const source = page();
    expect(source).toContain("shouldWarnOnPublishFailure({");
    // Re-reading permission after every failed GPS read cost a platform round
    // trip every twenty seconds for a value nothing on this path consumes.
    expect(source).not.toContain(
      'void refreshLocationPermission();\n        console.warn(\n          "[OneLocationAgent] Foreground live update skipped:",',
    );
  });
});
