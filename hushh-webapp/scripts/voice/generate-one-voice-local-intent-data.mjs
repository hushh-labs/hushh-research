import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const WEBAPP_ROOT = path.join(REPO_ROOT, "hushh-webapp");
const GATEWAY_PATH = path.join(
  WEBAPP_ROOT,
  "contracts/kai/kai-action-gateway.vnext.json",
);
const FIXTURE_PATH = path.join(
  WEBAPP_ROOT,
  "contracts/kai/one-voice-local-intent-evals.v1.json",
);
const OUTPUT_PATH = path.join(
  WEBAPP_ROOT,
  "contracts/kai/one-voice-local-intent-data.v1.json",
);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function agentNamespace(action) {
  const delegate = clean(action.delegate_agent_id);
  return delegate ? `agent_${delegate.replace(/^agent_/, "")}` : "agent_one";
}

function authoredPhrases(action) {
  return unique([action.label, ...(action.aliases || [])]).map((utterance) => ({
    utterance,
    action_id: action.action_id,
    agent_namespace: agentNamespace(action),
  }));
}

function pairwiseHardNegatives(actions) {
  const pairs = [];
  const bySurface = new Map();
  for (const action of actions) {
    const surface = clean(action.surface_id) || "unknown";
    const entries = bySurface.get(surface) || [];
    entries.push(action);
    bySurface.set(surface, entries);
  }
  for (const entries of bySurface.values()) {
    const sorted = [...entries].sort((left, right) =>
      left.action_id.localeCompare(right.action_id),
    );
    for (const action of sorted) {
      const phrase = authoredPhrases(action)[0];
      if (!phrase) continue;
      for (const negative of sorted) {
        if (negative.action_id === action.action_id) continue;
        pairs.push({
          utterance: phrase.utterance,
          positive_action_id: action.action_id,
          negative_action_id: negative.action_id,
        });
        if (pairs.length >= 2_000) return pairs;
      }
    }
  }
  return pairs;
}

function fixtureProjection(fixture) {
  return fixture.cases.map((entry) => ({
    id: entry.id,
    utterance: entry.utterance,
    expected: {
      disposition: entry.expected.disposition,
      action_id: entry.expected.actionId || null,
      read_capability: entry.expected.readCapability || null,
      slots: entry.expected.slots || {},
      missing_slots: entry.expected.missingSlots || [],
      reason: entry.expected.reason || null,
    },
    context: {
      available_action_ids: entry.context.availableActionIds || [],
      redacted_state: entry.context.redactedState || {},
    },
  }));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function main() {
  const [gateway, fixture] = await Promise.all([
    readJson(GATEWAY_PATH),
    readJson(FIXTURE_PATH),
  ]);
  const executableActions = gateway.actions
    .filter(
      (action) =>
        action.execution_target?.status === "wired" &&
        action.execution_policy !== "manual_only",
    )
    .sort((left, right) => left.action_id.localeCompare(right.action_id));
  const positiveExamples = executableActions.flatMap(authoredPhrases);
  const output = {
    schema_version: "one.voice_local_intent_data.v1",
    privacy: "authored-redacted-only",
    catalog_version: gateway.schema_version,
    preprocessing_version: "minilm-action-head-v1",
    model_contract: {
      runtime: "onnxruntime_web",
      entrypoint: "one_voice_intent_ranker_v2",
      input: "MiniLM utterance and generated-catalog candidate embeddings",
      output: "one pairwise score per generated candidate",
      artifacts: ["encoder.onnx", "ranker.onnx", "tokenizer.json", "action-index.json"],
    },
    positive_examples: positiveExamples,
    hard_negative_pairs: pairwiseHardNegatives(executableActions),
    fixture_cases: fixtureProjection(fixture),
    forbidden_predictions: fixture.cases
      .filter((entry) => entry.expected.reason || entry.expected.disposition === "unsupported")
      .map((entry) => ({
        id: entry.id,
        utterance: entry.utterance,
        forbidden_action_id: entry.expected.actionId || null,
        reason: entry.expected.reason || entry.expected.disposition,
      })),
    disambiguation_cases: fixture.cases
      .filter((entry) => entry.expected.disposition === "clarify")
      .map((entry) => ({ id: entry.id, utterance: entry.utterance })),
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = await fs.readFile(OUTPUT_PATH, "utf8").catch(() => "");
    if (current !== serialized) {
      throw new Error("Local intent training/evaluation data is stale");
    }
    console.log("Local intent training/evaluation data is current.");
    return;
  }
  await fs.writeFile(OUTPUT_PATH, serialized);
  console.log(`Generated local intent data: ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

await main();
