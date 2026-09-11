import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The words the agent is forbidden to say, applied to the words the app shows.
 *
 * `agent.yaml` binds the MODEL's speech: never say scope, consent lifecycle,
 * connector, domain, field or attribute to the owner. Nothing bound the React
 * chrome, so the chrome said all of it one line after the model obeyed --
 * "Consent review" as a heading, "14 fields" as a summary, the raw domain key
 * printed beside every row, and a bare `attr.*` string dropped into a sentence.
 * The rule existed and only half the product followed it.
 *
 * The ban list is READ OUT OF agent.yaml rather than restated here. That is the
 * point: add a word to the model's prompt and this test starts enforcing it on
 * the interface too, instead of the two drifting apart the way they already had.
 *
 * Scope is a curated list of owner-facing consent surfaces. A repo-wide scan
 * drowns in false positives -- identifiers, test ids, type names, `scope` as a
 * variable -- and a gate that cries wolf gets disabled. This catches the prose.
 */

const WEB_ROOT = path.resolve(__dirname, "../..");
const AGENT_YAML = path.resolve(
  WEB_ROOT,
  "../consent-protocol/hushh_mcp/agents/one/agent.yaml",
);

/** Owner-facing consent surfaces. Add a screen here when it starts showing scopes. */
const SURFACES = [
  "components/agent/agent-structured-experience.tsx",
  "components/agent/specialist-directive-card.tsx",
  "components/consent/consent-scope-list.tsx",
];

function bannedWords(): string[] {
  const yaml = readFileSync(AGENT_YAML, "utf8");
  // "Never say scope, consent lifecycle, connector, domain, field, or attribute"
  const match = yaml.match(/Never say ([^:]+?) to the owner/s);
  if (!match?.[1]) return [];
  return match[1]
    .replace(/\s+/g, " ")
    .split(/,|\bor\b/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 2);
}

/**
 * Text a person actually reads: JSX text nodes and the string literals in
 * label/title/summary/description/placeholder props. Deliberately not
 * identifiers, imports, types, testids or comments.
 */
function ownerFacingText(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  // JSX text nodes: >Some words<
  const jsxText = [...withoutComments.matchAll(/>\s*([A-Z][^<>{}\n]{3,})\s*</g)].map(
    (m) => m[1]!,
  );

  // Every double-quoted string that reads like prose, wherever it sits -- a JSX
  // prop, a default parameter, a ternary arm, a template's literal half. An
  // earlier version of this matched only `prop="..."` and therefore missed
  // `emptyText = "No scopes in this domain."`, a default parameter value, which
  // is exactly the shape a violation takes. A gate that cannot fail is worse
  // than no gate, because it reads as proof.
  const prose = [...withoutComments.matchAll(/"([^"\n]{6,})"/g)]
    .map((m) => m[1]!)
    // Prose has a space in it. Identifiers, class strings, import paths and
    // test ids do not, or are excluded below.
    .filter((text) => text.includes(" "))
    .filter((text) => !text.includes("/"))
    .filter((text) => !/^[a-z-]+(\s[a-z-]+)*$/.test(text) || /\b(the|your|you|a|an)\b/i.test(text))
    .filter((text) => !/[:;{}]/.test(text));

  return [...jsxText, ...prose];
}

describe("owner-facing consent vocabulary", () => {
  const banned = bannedWords();

  it("reads the ban list out of the agent contract, not from a copy here", () => {
    // If this ever returns nothing, every assertion below passes vacuously.
    expect(banned.length).toBeGreaterThan(3);
    expect(banned).toContain("scope");
    expect(banned).toContain("connector");
  });

  for (const surface of SURFACES) {
    it(`${surface} speaks plainly`, () => {
      const source = readFileSync(path.join(WEB_ROOT, surface), "utf8");
      const offenders: string[] = [];

      for (const text of ownerFacingText(source)) {
        for (const word of banned) {
          // Whole word only: "Sections" must not trip on "attribute", and a
          // heading like "Domain" is the offence, not the substring.
          if (new RegExp(`\\b${word}s?\\b`, "i").test(text)) {
            offenders.push(`"${text.trim()}" contains "${word}"`);
          }
        }
      }

      expect(
        offenders,
        `These are shown to a person and use our words for our plumbing:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
