import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

type RecordedStep = { text: string; answer: Record<string, unknown> };
export type MemoryRecording = {
  version: 1;
  document_sha256: string;
  steps: Record<string, RecordedStep>;
};

/** Replay synthetic agent answers, or refresh them through the owning backend. */
export function recordedMemoryServerAnswer(input: {
  text: string;
  recording: MemoryRecording;
  record: boolean;
  backend: string;
}): Record<string, unknown> {
  const { text, recording, record, backend } = input;
  const key = createHash("sha256").update(text, "utf8").digest("hex");
  if (!recording.steps[key]) {
    if (!record) throw new Error("No recorded server answer for this step; re-record (context_transfer_agents.py).");
    const output = execFileSync(path.join(backend, ".venv/bin/python"), ["-m", "tests.services.context_transfer_agents"], {
      cwd: backend,
      input: text,
      env: {
        ...process.env,
        TESTING: "true",
        APP_SIGNING_KEY: "test_secret_key_for_pytest_only_32chars_min",
        VAULT_DATA_KEY: "0".repeat(64),
      },
    });
    recording.steps[key] = { text, answer: JSON.parse(output.toString("utf8")) };
  }
  return { agent_id: "agent_pkm_structure", agent_name: "PKM Structure Agent", model: "recorded", ...recording.steps[key]!.answer };
}
