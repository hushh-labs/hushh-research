// Where the blocked-location recovery card has to appear.
//
// The card was added to the Location hub and nowhere else, so opening Save my
// Soul with location blocked still produced the original dead end: a toast that
// vanished, two console warnings, and a send button that refuses - with nothing
// on screen saying why or what to do. On a personal-safety surface that is the
// worst possible screen to leave unexplained.
//
// A source contract rather than a render test because `SosFlow` is an internal
// of a 2900-line module and depends on the whole view model; widening its
// export surface purely to assert one line of wiring would be a worse trade.
// This repo already guards placement this way.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const HUB = path.join(
  process.cwd(),
  "components/one-location/redesign/location-redesign-hub.tsx",
);

const source = readFileSync(HUB, "utf8");

/** The body of a top-level `function <name>(` declaration. */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found in the hub`).toBeGreaterThan(-1);
  // Next top-level declaration, or end of file.
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("blocked-location recovery placement", () => {
  it("is rendered by the SOS flow", () => {
    // The screen in the report. Location failing here is the difference between
    // an alert that sends a position and one that cannot.
    expect(functionBody("SosFlow")).toContain("LocationPermissionRecoveryCard");
  });

  it("is rendered by the Location hub", () => {
    expect(functionBody("LocationRedesignHub")).toContain(
      "LocationPermissionRecoveryCard",
    );
  });

  it("is gated on an observed block, never shown unconditionally", () => {
    // Telling someone their browser is blocking location when it is not sends
    // them into settings for no reason and teaches them to ignore the message.
    for (const fn of ["SosFlow", "LocationRedesignHub"]) {
      const body = functionBody(fn);
      const index = body.indexOf("LocationPermissionRecoveryCard");
      const around = body.slice(Math.max(0, index - 400), index + 400);
      expect(around, `${fn} must gate the card on locationBlocked`).toMatch(
        /locationBlocked/,
      );
    }
  });
});

describe("the immersive map does not fight its own mapId", () => {
  const MAP = path.join(
    process.cwd(),
    "components/one-location/location-immersive-map.tsx",
  );
  const mapSource = readFileSync(MAP, "utf8");

  it("passes no styles to a map the plugin gives a mapId", () => {
    // @capacitor/google-maps sets a mapId because advanced markers need one,
    // and Google ignores `styles` whenever a mapId is present - logging
    // "A Map's styles property cannot be set when a mapId is present" on every
    // map create. The styling never applied; only the warning did.
    expect(mapSource).not.toMatch(/^\s*styles:/m);
    expect(mapSource).not.toContain("DARK_MAP_STYLES,");
  });
});
