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

/**
 * A region of a file, bounded by two anchors that each occur exactly once.
 *
 * Used for a file too broad to scan whole: agent-chat-workspace.tsx is 6,600
 * lines of which a few hundred decide or describe consent. Anchoring on code
 * that exists, rather than on line numbers, means a refactor that moves the
 * block moves the gate with it, and a refactor that renames the anchor turns
 * the gate red rather than silently scanning nothing.
 */
type SurfaceRegion = {
  label: string;
  /** Text that starts the region. Must appear exactly once in the file. */
  from: string;
  /** Text that ends the region. Must appear exactly once, after `from`. */
  to: string;
};

type Surface = string | { path: string; regions: SurfaceRegion[] };

/** Owner-facing consent surfaces. Add a screen here when it starts showing scopes. */
const SURFACES: Surface[] = [
  "components/agent/agent-structured-experience.tsx",
  "components/agent/specialist-directive-card.tsx",
  "components/consent/consent-scope-list.tsx",
  "components/consent/consent-scope-nested-list.tsx",
  // Added after the gate was found silent on the one screen a person actually
  // meets when deciding what to ask someone for. It said "requestable fields",
  // "Search fields", "No fields match." and "Fields" as a heading -- four of the
  // exact words agent.yaml forbids the model to say -- and passed, because a
  // per-surface gate only guards the surfaces someone remembered to list.
  "components/connections/person-profile-page.tsx",
  // The Consent Center is where every decision lands, and it summarised a
  // history entry as "N consent events across M lifecycles" until 2026-09-14.
  "components/consent/consent-center-page.tsx",
  // The three modules that put words in the confirmation card and the toasts
  // behind an Approve, Deny, Revoke or Cancel: the FCM handlers, the shared
  // action hook, and the one sentence a person reads before confirming.
  "components/agent/global-consent-action-handlers.tsx",
  "lib/consent/use-consent-actions.ts",
  "lib/agent/action-directive-summary.ts",
  // The chat workspace, restricted to the blocks that decide or describe a
  // consent request. The rest of the file is a chat surface with its own
  // vocabulary, and scanning it whole is how a gate turns into a wolf cry.
  {
    path: "components/agent/agent-chat-workspace.tsx",
    regions: [
      {
        label: "pending-consent hydration",
        from: "const appendPendingConsentRequest = async (requestId: string) => {",
        to: "const handleConsentMessage = (event: Event) => {",
      },
      {
        label: "FCM consent handlers",
        from: "const handleConsentMessage = (event: Event) => {",
        to: "window.removeEventListener(FCM_MESSAGE_EVENT, handleConsentMessage);",
      },
      {
        label: "Approve / Deny / Details handlers",
        from: "busyConsentItemId={specialistBusyItemId}",
        to: "emailDeliveryTimeline.itemsAfterMessage.get(message.id)",
      },
      {
        label: "confirmation card render",
        from: "{pendingAppAction ? (",
        to: "{pendingSpecialistDirective ? (",
      },
    ],
  },
];

/** The gateway contract whose consent.* labels and aliases the app reads aloud. */
const VOICE_ACTION_CONTRACT =
  "components/consent/consent-center-page.voice-action-contract.json";

/** The chat client that used to print the model-facing `meaning` to the owner. */
const AGENT_CHAT_CLIENT = "lib/services/agent-chat-client.ts";

function surfacePath(surface: Surface): string {
  return typeof surface === "string" ? surface : surface.path;
}

/**
 * The text the gate scans for a surface: the whole file, or only its named
 * regions. Each anchor must occur exactly once, and `to` must follow `from`,
 * so a moved or renamed anchor fails here instead of shrinking the scan to
 * nothing and passing.
 */
function surfaceText(surface: Surface, source: string): string {
  if (typeof surface === "string") return source;
  return surface.regions
    .map((region) => {
      const count = (needle: string) => source.split(needle).length - 1;
      expect(
        count(region.from),
        `${surface.path}: region "${region.label}" start anchor must occur exactly once: ${region.from}`,
      ).toBe(1);
      expect(
        count(region.to),
        `${surface.path}: region "${region.label}" end anchor must occur exactly once: ${region.to}`,
      ).toBe(1);
      const start = source.indexOf(region.from);
      const end = source.indexOf(region.to, start + region.from.length);
      expect(
        end,
        `${surface.path}: region "${region.label}" end anchor must follow its start anchor`,
      ).toBeGreaterThan(start);
      return source.slice(start, end + region.to.length);
    })
    .join("\n");
}

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
    .replace(/^\s*\/\/.*$/gm, " ")
    // A console line is read by whoever opens the devtools, never by the
    // owner. Without this the shared action hook fails on
    // `console.warn("Failed to decrypt field: ...")`, which is the right word
    // for a developer and would only teach people to ignore the gate.
    .replace(/\bconsole\.\w+\([\s\S]*?\);/g, " ");

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

  // Template literals, with their ${...} holes removed.
  //
  // Added after this gate was extended to person-profile-page and reported
  // PASS on a line that read "N requestable fields" -- because that sentence
  // lives in a template literal, and the two matchers above only see
  // double-quoted strings and JSX text. The gate could not fail on the exact
  // string that prompted the audit. Interpolations are dropped rather than
  // kept: they are identifiers, and matching them would flag `scope.domain`
  // as prose and train everyone to ignore this test.
  const templates = [...withoutComments.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1]!.replace(/\$\{[^}]*\}/g, " "))
    .filter((text) => text.trim().length > 5)
    .filter((text) => text.includes(" "))
    .filter((text) => !text.includes("/"));

  // JSX text nodes with {...} holes in them: `{requester} is asking for
  // {access}.`, `Reason: {item.reason}`, `For {duration}.`
  //
  // The first matcher above stops at the first brace, so a sentence that
  // opens with a hole was never read at all, and one that ends in a hole lost
  // its tail. The pending-request card says most of what it says this way.
  // The holes are stripped, as with template literals, and the remainder has
  // to read as prose: a letter-run of three or more, and none of the
  // characters that mark a ternary arm, a call or an arrow. Newlines are
  // allowed because JSX text wraps; the code that also sits between a `>` and
  // a `<` always carries one of the excluded characters.
  const jsxTextWithHoles = [...withoutComments.matchAll(/>([^<>]*\{[^<>]*)</g)]
    .map((m) => m[1]!.replace(/\{[^{}]*\}/g, " ").replace(/\s+/g, " ").trim())
    .filter((text) => /[A-Za-z]{3,}/.test(text))
    .filter((text) => !/[`$=()&|;?]/.test(text))
    .filter((text) => !text.includes("/"));

  return [...jsxText, ...prose, ...templates, ...jsxTextWithHoles];
}

/**
 * The offending strings in `text`, each named with the banned word it uses.
 * Whole word only: "Sections" must not trip on "attribute", and a heading like
 * "Domain" is the offence, not the substring.
 */
function offendersIn(text: string[], banned: string[]): string[] {
  const offenders: string[] = [];
  for (const candidate of text) {
    for (const word of banned) {
      if (new RegExp(`\\b${word}s?\\b`, "i").test(candidate)) {
        offenders.push(`"${candidate.trim()}" contains "${word}"`);
      }
    }
  }
  return offenders;
}

describe("owner-facing consent vocabulary", () => {
  const banned = bannedWords();

  it("reads the ban list out of the agent contract, not from a copy here", () => {
    // If this ever returns nothing, every assertion below passes vacuously.
    expect(banned.length).toBeGreaterThan(3);
    expect(banned).toContain("scope");
    expect(banned).toContain("connector");
  });

  it("catches a banned word in every shape of owner-facing text", () => {
    // The matchers are regexes over source, and a regex that drifts stops
    // matching silently: the gate went green on "N requestable fields" once
    // because that sentence lived in a template literal nobody scanned. This
    // is one clean fixture per shape, with the same banned word planted in
    // each, so a matcher that goes blind fails here rather than passing the
    // surfaces above.
    const fixture = [
      '<p className="text-sm">Choose a field to share</p>',
      "<p>{requester} is asking for a field.</p>",
      'const emptyText = "No fields match your search.";',
      "const line = `${count} requestable fields`;",
    ].join("\n");
    const offenders = offendersIn(ownerFacingText(fixture), banned);
    expect(offenders).toHaveLength(4);
    for (const offender of offenders) {
      expect(offender).toMatch(/contains "field"/);
    }

    // And the same shapes read clean when the word is a person's word.
    const clean = fixture.replaceAll("field", "address");
    expect(offendersIn(ownerFacingText(clean), banned)).toEqual([]);
  });

  for (const surface of SURFACES) {
    const name = surfacePath(surface);
    it(`${name} speaks plainly`, () => {
      const source = readFileSync(path.join(WEB_ROOT, name), "utf8");
      const offenders = offendersIn(
        ownerFacingText(surfaceText(surface, source)),
        banned,
      );

      expect(
        offenders,
        `These are shown to a person and use our words for our plumbing:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }

  it("names the consent.* gateway actions in the owner's words", () => {
    // The label is what the confirmation card and the voice surface read
    // aloud; the aliases are what a person is expected to say. Both are
    // owner-facing. `meaning` and `search_keywords` are written for the model
    // and its retrieval index, and are deliberately not scanned.
    const contract = JSON.parse(
      readFileSync(path.join(WEB_ROOT, VOICE_ACTION_CONTRACT), "utf8"),
    ) as {
      actions: Array<{ action_id: string; label?: string; aliases?: string[] }>;
    };
    const consentActions = contract.actions.filter((action) =>
      action.action_id.startsWith("consent."),
    );
    // If the contract ever stops carrying consent actions the loop below is
    // vacuous, and that is a change worth failing on.
    expect(consentActions.length).toBeGreaterThanOrEqual(4);

    const spoken = consentActions.flatMap((action) => [
      ...(action.label ? [action.label] : []),
      ...(action.aliases ?? []),
    ]);
    const offenders = offendersIn(spoken, banned);

    expect(
      offenders,
      `These gateway labels or aliases are read to a person and use our words for our plumbing:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("never shows the owner the model-facing meaning of an action", () => {
    // `meaning` in the gateway contract names a category of action for the
    // model ("Sends an information request ... for the exact fields ...").
    // The chat client printed it as the confirmation sentence until
    // 2026-09-14, so a person approving a request confirmed a category and a
    // sentence full of the words above. The owner's sentence is built from
    // the resolved slots instead, and this holds that line.
    const client = readFileSync(path.join(WEB_ROOT, AGENT_CHAT_CLIENT), "utf8");
    expect(client).not.toContain("action?.meaning");
    expect(client).not.toMatch(/message:\s*[^,\n]*\.meaning\b/);
    expect(client).toContain("describeDirectiveForOwner(");
  });
});
