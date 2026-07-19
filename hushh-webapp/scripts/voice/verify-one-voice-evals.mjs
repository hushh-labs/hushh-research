#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const gateway = JSON.parse(fs.readFileSync(path.join(root, "contracts/kai/kai-action-gateway.vnext.json"), "utf8"));
const fixture = JSON.parse(fs.readFileSync(path.join(root, "contracts/kai/one-voice-utterance-evals.v1.json"), "utf8"));
if (fixture.schema_version !== "one.voice_utterance_evals.v1") throw new Error("Unsupported One voice evaluation fixture.");
const byId = new Map((gateway.actions || []).map((action) => [action.action_id, action]));
const ids = new Set();
for (const testCase of fixture.cases || []) {
  if (!testCase.id || ids.has(testCase.id)) throw new Error(`Invalid or duplicate evaluation case: ${testCase.id || "unknown"}`);
  ids.add(testCase.id);
  if (!testCase.category || !testCase.utterance || !testCase.context || !Array.isArray(testCase.forbidden_directives)) throw new Error(`Incomplete evaluation case: ${testCase.id}`);
  if (testCase.expected_action_id && !byId.has(testCase.expected_action_id)) throw new Error(`${testCase.id}: expected action is not generated`);
  for (const actionId of testCase.forbidden_directives) if (!byId.has(actionId)) throw new Error(`${testCase.id}: forbidden action is not generated`);
  if (testCase.expected_goal_id) {
    const action = byId.get(testCase.expected_action_id);
    if (action?.goal?.goal_id !== testCase.expected_goal_id) throw new Error(`${testCase.id}: expected goal does not belong to expected action`);
  }
}
console.info(`One voice evaluations are valid (${ids.size} redacted cases).`);
