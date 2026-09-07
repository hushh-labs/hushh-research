#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webappRoot = path.resolve(__dirname, "../..");
const gatewayPath = path.join(
  webappRoot,
  "contracts/kai/kai-action-gateway.vnext.json",
);
const swiftCoordinatorPath = path.join(
  webappRoot,
  "ios/App/App/OneSystemActionInvocationCoordinator.swift",
);
const swiftIntentsPath = path.join(
  webappRoot,
  "ios/App/App/OneVoiceAppIntent.swift",
);
const typescriptBridgePath = path.join(
  webappRoot,
  "lib/capacitor/one-system-action-invocation.ts",
);

const EXPOSED_MODES = new Set(["direct", "review_ui"]);
// location.trigger_sos is deliberately absent: it is now a direct Siri action,
// reachable from exactly one App Intent, and that reachability is asserted
// separately in verifySaveMySoulSeparation below.
//
// location.sos_default stays forbidden and must never become direct. It
// branches on a stored preference, so what it does is not knowable from the
// phrase alone -- a hardware button or a misheard word must never resolve to
// "whatever this person once chose".
const FORBIDDEN_DIRECT_IDS = [
  "location.sos_default",
  "location.delete_circle",
];

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function sorted(values) {
  return [...values].sort();
}

function assertEqualSets(label, actual, expected) {
  const actualValues = sorted(actual);
  const expectedValues = sorted(expected);
  if (JSON.stringify(actualValues) === JSON.stringify(expectedValues)) return;
  const actualSet = new Set(actualValues);
  const expectedSet = new Set(expectedValues);
  const missing = expectedValues.filter((value) => !actualSet.has(value));
  const extra = actualValues.filter((value) => !expectedSet.has(value));
  throw new Error(
    `${label} drifted (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
}

function parseSwiftActionCases(source) {
  const enumMatch = source.match(
    /enum OneSystemActionID:[\s\S]*?\n}\n\nstruct PendingOneSystemActionInvocation/,
  );
  if (!enumMatch) throw new Error("Could not find the OneSystemActionID enum");
  const cases = new Map();
  for (const match of enumMatch[0].matchAll(
    /case\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*"([^"]+)"/g,
  )) {
    cases.set(match[1], match[2]);
  }
  if (cases.size === 0) throw new Error("OneSystemActionID has no raw-value cases");
  return cases;
}

function parseSwiftActionSet(source, name, cases) {
  const expression = new RegExp(
    `static let ${name}: Set<OneSystemActionID> = \\[([\\s\\S]*?)\\n    \\]`,
  );
  const match = source.match(expression);
  if (!match) throw new Error(`Could not find Swift action set ${name}`);
  const result = new Set();
  for (const caseMatch of match[1].matchAll(/\.([A-Za-z][A-Za-z0-9_]*)/g)) {
    const actionId = cases.get(caseMatch[1]);
    if (!actionId) {
      throw new Error(`${name} references unknown Swift case ${caseMatch[1]}`);
    }
    result.add(actionId);
  }
  return result;
}

function parseTypescriptActionIds(source) {
  const match = source.match(
    /export const ONE_SYSTEM_ACTION_IDS = \[([\s\S]*?)\] as const;/,
  );
  if (!match) throw new Error("Could not find ONE_SYSTEM_ACTION_IDS");
  return new Set(
    [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
  );
}

function verifyShortcutPhrases(source) {
  const shortcutCount = [...source.matchAll(/\bAppShortcut\(/g)].length;
  // Apple caps App Shortcuts at 10 and enforces it at compile time, so the
  // upper bound is the real safety invariant. The exact count is pinned too, so
  // that silently dropping one to make room is a failing test rather than a
  // quiet regression.
  if (shortcutCount > 10) {
    throw new Error(
      `App Shortcuts exceed Apple's limit of 10, found ${shortcutCount}`,
    );
  }
  if (shortcutCount !== 9) {
    throw new Error(`Expected 9 App Shortcuts, found ${shortcutCount}`);
  }
  // Both halves of Save My Soul must hold a slot. Registration is the only
  // thing that puts a shortcut in the Action button picker, and the picker is
  // the whole point of the sending half.
  for (const [registration, why] of [
    [
      "intent: OpenOneEmergencySOSIntent()",
      "the only voice and Action-button route to the SOS screen",
    ],
    [
      "intent: SendSaveMySoulAlertIntent()",
      "the only route that actually sends the alert, and the one meant for the Action button",
    ],
  ]) {
    if (!source.includes(registration)) {
      throw new Error(
        `Save My Soul must keep its App Shortcut (${registration}): it is ${why}`,
      );
    }
  }
  // Phrases interpolate the `agentOne` constant, not a literal
  // \(.applicationName). Matching the wrong form silently passes.
  for (const phrase of ['"SMS in \\(agentOne)"', '"Save my soul in \\(agentOne)"']) {
    if (!source.includes(phrase)) {
      throw new Error(`Emergency SOS must keep its ${phrase} phrase`);
    }
  }
  if (source.includes('"Ask \\(agentOne)"')) {
    throw new Error("Bare Ask Agent One must not advertise the conversation intent");
  }
  // These assert the phrases the app actually ships.
  //
  // They previously asserted a \(.applicationName) interpolation that appears
  // nowhere in the Swift, and an "Ask X to Y" phrase style the app moved away
  // from. None of it was caught, because the shortcut-count check above threw
  // first and this loop never ran. Treat a failure here as real drift.
  const requiredFragments = [
    // Conversation entry stays explicit, and a bare "Ask" must not claim it.
    '"Talk to \\(agentOne)"',
    '"Start a conversation with \\(agentOne)"',
    // Free-text handshake into semantic routing.
    '"Ask \\(agentOne) with \\(\\.$requestText)"',
    // Location sharing, including the parameterised recipient form.
    '"Share my location with \\(\\.$recipient) in \\(agentOne) Location Agent"',
    '"Ask \\(agentOne) to share my location',
    // Circles. No \(\.$name) slot -- an open string slot has no value set for
    // Siri to match, so naming a Circle out loud goes through the handshake.
    '"Create a Circle in \\(agentOne) Location Agent"',
    '"Start a Circle in \\(agentOne)"',
    // Check-in.
    '"Check in with \\(agentOne) Location Agent"',
    '"Open \\(agentOne) Location Check In"',
    // Save My Soul: the in-product name and its abbreviation must both work.
    '"SMS in \\(agentOne)"',
    '"Save my soul in \\(agentOne)"',
    '"Emergency SOS in \\(agentOne)"',
    // ...and the sending half needs an unmistakable phrase of its own.
    '"Send my Save My Soul alert in \\(agentOne)"',
  ];

  const missing = requiredFragments.filter((fragment) => !source.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`Missing governed Siri phrase fragments: ${missing.join(", ")}`);
  }

  // These are aliases of location.sos_default, which honours the person's own
  // "In an emergency" preference. On an intent that only ever opens, they
  // would silently override that choice for anyone who set it to send.
  for (const phrase of ['"I need help in \\(agentOne)"', '"Help me in \\(agentOne)"']) {
    if (source.includes(phrase)) {
      throw new Error(
        `${phrase} belongs to location.sos_default, not to an open-only intent`,
      );
    }
  }
}

/**
 * App Shortcut phrases must actually be able to compile.
 *
 * AppShortcutPhrase's StringInterpolation declares exactly two overloads -- an
 * AppShortcutPhraseToken and a parameter KeyPath. There is no String overload,
 * and AppShortcut(phrases:) takes [AppShortcutPhrase<Intent>], not [String].
 * Both rules were broken at once on this branch: `agentOne` was declared as the
 * String ".applicationName" and six phrase families were typed [String], so the
 * target could never have built. Nothing caught it, because a Swift *parse*
 * succeeds on all of it and no CI job had run on the branch.
 */
function verifyPhraseTypes(source) {
  const tokenDecl = /private static let agentOne:\s*AppShortcutPhraseToken\s*=\s*\.applicationName/;
  if (!tokenDecl.test(source)) {
    throw new Error(
      "agentOne must be `private static let agentOne: AppShortcutPhraseToken = .applicationName` -- " +
        "a String cannot be interpolated into an AppShortcutPhrase and will not compile",
    );
  }
  const stringTyped = [
    ...source.matchAll(/static let (\w*[Pp]hrases):\s*\[String\]/g),
  ].map((match) => match[1]);
  if (stringTyped.length > 0) {
    throw new Error(
      `Phrase families must be typed [AppShortcutPhrase<Intent>], not [String]: ${stringTyped.join(", ")}`,
    );
  }
  // Every registered shortcut must pass a phrase array, never an inline literal
  // that would dodge the typing rule above.
  const phraseArrays = [
    ...source.matchAll(/static let (\w*[Pp]hrases):\s*\[AppShortcutPhrase<(\w+)>\]/g),
  ];
  if (phraseArrays.length < 9) {
    throw new Error(
      `Expected at least 9 typed phrase families, found ${phraseArrays.length}`,
    );
  }
}

/**
 * The phrase-corpus invariants.
 *
 * These lived in AppTests/AgentOneSiriSemanticCorpusTests.swift until this
 * change. That file could never compile and never ran: it asserted against
 * `AppShortcut.shortTitle` and `AppShortcut.phrases`, and AppShortcut exposes
 * no public properties at all -- only initialisers. The invariants it was
 * reaching for are real, so they moved here, where they read the source text
 * and actually execute on every CI job rather than only on a macOS runner.
 */
function verifyPhraseCorpus(source) {
  const families = new Map();
  const pattern =
    /static let (\w*[Pp]hrases):\s*\[AppShortcutPhrase<(\w+)>\]\s*=\s*\[([\s\S]*?)\n    \]/g;
  for (const match of source.matchAll(pattern)) {
    const [, name, intent, body] = match;
    const phrases = [...body.matchAll(/^\s*"([^"\n]*)",?\s*$/gm)].map((m) => m[1]);
    families.set(name, { intent, phrases });
  }
  if (families.size === 0) {
    throw new Error("Could not parse any Siri phrase family");
  }

  // Minimum breadth per family. Apple's similarity index generalises beyond the
  // exact strings, but it needs distinct anchors to generalise *from*; a family
  // thinned to one or two phrases stops matching paraphrases.
  const minimums = {
    shareLocationPhrases: 8,
    askForLocationPhrases: 6,
    locationStatePhrases: 6,
    checkInPhrases: 4,
    createCirclePhrases: 4,
    talkToAgentOnePhrases: 3,
    askOneRequestPhrases: 3,
    emergencySOSPhrases: 5,
    sendSaveMySoulPhrases: 4,
  };

  for (const [name, { phrases }] of families) {
    const floor = minimums[name];
    if (floor !== undefined && phrases.length < floor) {
      throw new Error(
        `${name} has ${phrases.length} phrases, below its floor of ${floor}`,
      );
    }

    const seen = new Set();
    for (const phrase of phrases) {
      // The app-name token, in every phrase. It is what wins Siri's domain
      // arbitration against system apps, and what survives localisation.
      if (!phrase.includes("\\(agentOne)")) {
        throw new Error(
          `Every Siri phrase must carry the app-name token; ${name} has: "${phrase}"`,
        );
      }
      // ...and never the literal product name, which does neither.
      if (/Agent One/.test(phrase)) {
        throw new Error(
          `Use the app-name token, not the literal "Agent One"; ${name} has: "${phrase}"`,
        );
      }
      if (seen.has(phrase)) {
        throw new Error(`${name} repeats the phrase "${phrase}"`);
      }
      seen.add(phrase);
    }
  }

  // Recipients are always a resolved slot, never a name baked into a phrase.
  const nameSlotted = ["shareLocationPhrases", "askForLocationPhrases"];
  for (const name of nameSlotted) {
    const family = families.get(name);
    if (!family) throw new Error(`Missing phrase family ${name}`);
    for (const phrase of family.phrases) {
      if (!/\\\(\\\.\$(recipient|person)\)/.test(phrase)) {
        throw new Error(
          `${name} must resolve its person through a slot, not a literal; "${phrase}" has none`,
        );
      }
    }
  }

  // Location on/off must bind its state slot in every phrase. `state` is
  // non-optional with no default, so an unbound phrase makes Siri stop and ask
  // "On or Off?" instead of acting.
  for (const phrase of families.get("locationStatePhrases")?.phrases ?? []) {
    if (!/\\\(\\\.\$state\)/.test(phrase)) {
      throw new Error(
        `Every Location On or Off phrase must bind the state slot; "${phrase}" does not`,
      );
    }
  }
}

/**
 * The invariant that keeps a hardware button from becoming a spoken kill-word.
 *
 * App Intents expose no invocation source, so an intent that sends, sends from
 * every phrase it answers to. Sending therefore lives in exactly one intent,
 * and this asserts it stays that way -- a future edit that points the short
 * "SMS" phrases at the sending action fails here rather than in someone's
 * pocket.
 */
function verifySaveMySoulSeparation(source) {
  const ownerOf = (index) => {
    const preceding = source.slice(0, index);
    const declarations = [
      ...preceding.matchAll(/\n(?:struct|enum|extension|final class|class)\s+([A-Za-z0-9_]+)/g),
    ];
    return declarations.at(-1)?.[1] ?? "<file scope>";
  };
  const ownersReferencing = (needle) => {
    const owners = new Set();
    let from = 0;
    for (;;) {
      const index = source.indexOf(needle, from);
      if (index === -1) break;
      owners.add(ownerOf(index));
      from = index + needle.length;
    }
    return owners;
  };

  const sendOwners = new Set([
    ...ownersReferencing(".triggerSaveMySoul"),
    ...ownersReferencing("sendSaveMySoulAlert("),
  ]);
  const permittedSendOwners = new Set([
    "SendSaveMySoulAlertIntent",
    "OneAppIntentActionRequestFactory",
  ]);
  const trespassers = [...sendOwners].filter(
    (owner) => !permittedSendOwners.has(owner),
  );
  if (sendOwners.size === 0) {
    throw new Error("Nothing reaches location.trigger_sos: the send path is gone");
  }
  if (trespassers.length > 0) {
    throw new Error(
      `Only SendSaveMySoulAlertIntent may send a Save My Soul alert; also reached from: ${trespassers.join(", ")}`,
    );
  }

  // The open side may legitimately be reached two ways: its own intent, and
  // the destination entity that resolves "open the SOS screen" phrases. Both
  // only ever open. Anything else appearing here means a new path to the SOS
  // screen grew without review.
  const openOwners = ownersReferencing(".openEmergencySOS");
  const permittedOpenOwners = new Set([
    "OpenOneEmergencySOSIntent",
    "AgentOneDestination",
  ]);
  const unexpectedOpenOwners = [...openOwners].filter(
    (owner) => !permittedOpenOwners.has(owner),
  );
  if (!openOwners.has("OpenOneEmergencySOSIntent")) {
    throw new Error(
      "OpenOneEmergencySOSIntent no longer opens location.open_sos -- it has been repointed",
    );
  }
  if (unexpectedOpenOwners.length > 0) {
    throw new Error(
      `Unreviewed paths to the SOS screen: ${unexpectedOpenOwners.join(", ")}`,
    );
  }

  // And the open intent must stay open-only: it must not reach the sending
  // action, which is what would make the short "SMS" phrase alert people.
  const openBlock = source.match(
    /struct OpenOneEmergencySOSIntent[\s\S]*?\n\}\n/,
  )?.[0];
  if (!openBlock) {
    throw new Error("Could not isolate OpenOneEmergencySOSIntent");
  }
  if (openBlock.includes("triggerSaveMySoul")) {
    throw new Error("OpenOneEmergencySOSIntent must never reach the sending action");
  }
}

function verifyEnvelopeSeparation(source) {
  const executor = source.match(
    /private enum OneAppIntentActionExecutor \{([\s\S]*?)\n\}\n\n\/\/ MARK: - Conversational fallback/,
  )?.[1];
  const conversation = source.match(
    /struct TalkToHusshOneIntent: AppIntent \{([\s\S]*?)\n\}\n\n\/\/ MARK: - Direct Location actions/,
  )?.[1];
  if (!executor || !conversation) {
    throw new Error("Could not isolate Siri action and conversation executors");
  }
  if (
    !executor.includes("OneSystemActionInvocationCoordinator.shared.enqueue") ||
    executor.includes("OneVoiceInvocationCoordinator")
  ) {
    throw new Error(
      "Direct Siri execution must enqueue only execute_one_action requests",
    );
  }
  if (
    !conversation.includes("OneVoiceInvocationCoordinator.shared.enqueue") ||
    conversation.includes("OneSystemActionInvocationCoordinator")
  ) {
    throw new Error(
      "The explicit conversation intent must enqueue only start_one_voice requests",
    );
  }
  if (/\[SIRI_ONE_ACTION\][^\n]*source=/.test(source)) {
    throw new Error("Siri lifecycle logs must omit fields outside the redacted schema");
  }
}

function verifyVaultFeedback(intentsSource, coordinatorSource, handoffSource) {
  const requiredIntentCopy =
    "Agent One's Vault is locked. I've opened the app for you. Unlock your Vault, and I'll continue your request.";
  const requiredPauseCopy =
    "Agent One's Vault is locked. I opened Location Settings for you. Unlock your Vault, then ask me again to pause location sharing.";
  if (!intentsSource.includes(requiredIntentCopy)) {
    throw new Error("The App Intent must return the governed locked-vault dialog");
  }
  if (!coordinatorSource.includes('case waitingForVault = "waiting_for_vault"')) {
    throw new Error("The native coordinator must recognize waiting_for_vault progress");
  }
  if (
    !handoffSource.includes("OneSystemActionInvocationBridge.reportProgress") ||
    !handoffSource.includes(requiredPauseCopy)
  ) {
    throw new Error("The browser handoff must report vault progress and retain pause safety copy");
  }
}

const gateway = JSON.parse(read(gatewayPath));
const actions = Array.isArray(gateway.actions) ? gateway.actions : [];
const direct = actions.filter((action) => action.siri_mode === "direct");
const review = actions.filter((action) => action.siri_mode === "review_ui");
const conversation = actions.filter(
  (action) => action.siri_mode === "conversation_only",
);
if (direct.length !== 8 || review.length !== 10 || conversation.length !== 1) {
  throw new Error(
    `Expected Siri modes direct=8 review_ui=10 conversation_only=1; found ${direct.length}/${review.length}/${conversation.length}`,
  );
}
if (conversation[0]?.action_id !== "location.chat.turn") {
  throw new Error("location.chat.turn must be the sole conversation_only action");
}

const actionsById = new Map(actions.map((action) => [action.action_id, action]));
for (const actionId of FORBIDDEN_DIRECT_IDS) {
  if (actionsById.get(actionId)?.siri_mode !== "unsupported") {
    throw new Error(`${actionId} must remain unsupported for direct Siri execution`);
  }
}

const exposedIds = new Set(
  actions
    .filter((action) => EXPOSED_MODES.has(action.siri_mode))
    .map((action) => action.action_id),
);
const vaultIds = new Set(
  actions
    .filter(
      (action) =>
        EXPOSED_MODES.has(action.siri_mode) && action.siri_requires_vault === true,
    )
    .map((action) => action.action_id),
);
const confirmationIds = new Set(
  actions
    .filter(
      (action) =>
        EXPOSED_MODES.has(action.siri_mode) &&
        action.execution_policy === "confirm_required",
    )
    .map((action) => action.action_id),
);

const swiftSource = read(swiftCoordinatorPath);
const swiftCases = parseSwiftActionCases(swiftSource);
assertEqualSets("Swift OneSystemActionID", swiftCases.values(), exposedIds);
assertEqualSets(
  "Swift vault-required actions",
  parseSwiftActionSet(swiftSource, "vaultRequiredActionIDs", swiftCases),
  vaultIds,
);
assertEqualSets(
  "Swift system-confirmation actions",
  parseSwiftActionSet(
    swiftSource,
    "systemConfirmationRequiredActionIDs",
    swiftCases,
  ),
  confirmationIds,
);

assertEqualSets(
  "TypeScript ONE_SYSTEM_ACTION_IDS",
  parseTypescriptActionIds(read(typescriptBridgePath)),
  exposedIds,
);
verifyShortcutPhrases(read(swiftIntentsPath));
verifyPhraseTypes(read(swiftIntentsPath));
verifyPhraseCorpus(read(swiftIntentsPath));
verifyEnvelopeSeparation(read(swiftIntentsPath));
verifySaveMySoulSeparation(read(swiftIntentsPath));

const handoffSource = read(
  path.join(webappRoot, "components/agent/siri-one-action-handoff.tsx"),
);
verifyVaultFeedback(read(swiftIntentsPath), swiftSource, handoffSource);
if (/\[SIRI_ONE_ACTION\][^\n]*source=/.test(handoffSource)) {
  throw new Error("Siri lifecycle logs must omit source and private payload fields");
}

console.info(
  `Siri action contract verified (${direct.length} direct, ${review.length} review UI, ${conversation.length} conversation-only).`,
);
