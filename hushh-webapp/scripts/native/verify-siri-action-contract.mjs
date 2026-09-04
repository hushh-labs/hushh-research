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
const FORBIDDEN_DIRECT_IDS = [
  "location.trigger_sos",
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
  if (shortcutCount !== 9) {
    throw new Error(`Expected 9 App Shortcuts, found ${shortcutCount}`);
  }
  if (source.includes('"Ask \\(.applicationName)"')) {
    throw new Error("Bare Ask Agent One must not advertise the conversation intent");
  }
  const requiredFragments = [
    '"Talk to \\(.applicationName)"',
    '"Start a conversation with \\(.applicationName)"',
    '"Ask \\(.applicationName) to share my location',
    '"Tell \\(.applicationName) to share my location',
    '"Talk to \\(.applicationName) and share my location',
    '"Ask \\(.applicationName) to ask',
    '"Tell \\(.applicationName) to request',
    '"Talk to \\(.applicationName) and ask',
    '"Ask \\(.applicationName) to stop sharing location',
    '"Tell \\(.applicationName) to stop sharing location',
    '"Talk to \\(.applicationName) and stop sharing location',
    '"Ask \\(.applicationName) to pause my location"',
    '"Tell \\(.applicationName) to pause my location"',
    '"Talk to \\(.applicationName) and pause my location"',
    '"Ask \\(.applicationName) to turn Location',
    '"Tell \\(.applicationName) to turn Location',
    '"Talk to \\(.applicationName) and turn Location',
    '"Ask \\(.applicationName) to create a Circle"',
    '"Tell \\(.applicationName) to create a Circle"',
    '"Talk to \\(.applicationName) and create a Circle"',
    'intent: RenameOneCircleIntent()',
    '"Ask \\(.applicationName) to rename',
    '"Tell \\(.applicationName) to rename',
    '"Talk to \\(.applicationName) and rename',
    '"Ask \\(.applicationName) to check in"',
    '"Tell \\(.applicationName) to open Check In"',
    '"Talk to \\(.applicationName) and check in"',
    '"Ask \\(.applicationName) to open',
    '"Tell \\(.applicationName) to show',
    '"Talk to \\(.applicationName) and open',
  ];
  const missing = requiredFragments.filter((fragment) => !source.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`Missing governed Siri phrase fragments: ${missing.join(", ")}`);
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
if (direct.length !== 7 || review.length !== 10 || conversation.length !== 1) {
  throw new Error(
    `Expected Siri modes direct=7 review_ui=10 conversation_only=1; found ${direct.length}/${review.length}/${conversation.length}`,
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
verifyEnvelopeSeparation(read(swiftIntentsPath));

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
