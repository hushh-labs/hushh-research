import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workspacePath = path.resolve(
  process.cwd(),
  "components/agent/agent-chat-workspace.tsx",
);

describe("Agent command handoff contract", () => {
  it("starts Ask One prompts in a new chat and prevents late history restoration", () => {
    const source = fs.readFileSync(workspacePath, "utf8");
    const userRequestedBranch = source.slice(
      source.indexOf('if (handoff.reason === "user_requested" && transcript)'),
      source.indexOf("if (transcript)", source.indexOf('if (handoff.reason === "user_requested" && transcript)')),
    );

    expect(userRequestedBranch).toContain(
      "skipInitialHistoryLoadRef.current = shouldSkipInitialHistoryLoad",
    );
    expect(userRequestedBranch).toContain("handleCreateNewChat()");
    expect(userRequestedBranch).toContain("setQueuedHandoffPrompt(transcript)");
    expect(source).toContain("const restoreEpoch = historyRestoreEpochRef.current");
    expect(source).toContain(
      "cancelled || restoreEpoch !== historyRestoreEpochRef.current",
    );
  });

  it("joins the unlock PKM warmup before falling back to a turn-specific load", () => {
    const source = fs.readFileSync(workspacePath, "utf8");
    const loadContext = source.slice(
      source.indexOf("const loadTurnPkmContext"),
      source.indexOf(
        "let agentPkmContext = EMPTY_PKM_CONTEXT",
        source.indexOf("const loadTurnPkmContext"),
      ),
    );

    expect(loadContext).toContain("warmAgentPkmContext({");
    expect(loadContext).toContain("peekAgentPkmContext({ userId, message: text })");
    expect(loadContext).toContain("loadAgentPkmContext({");
  });
});
