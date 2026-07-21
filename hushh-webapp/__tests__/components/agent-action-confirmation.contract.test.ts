import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("private-agent action confirmation contract", () => {
  it("keeps typed actions inert until confirm and consume complete", () => {
    const source = fs.readFileSync(
      path.join(root, "components/agent/agent-chat-workspace.tsx"),
      "utf8",
    );
    const confirmAt = source.indexOf("await confirmAgentChatAction({");
    const consumeAt = source.indexOf("await consumeAgentChatAction({", confirmAt);
    const receiptAt = source.indexOf("return confirmation.receipt;", consumeAt);
    const executeAt = source.indexOf("await executeFrontendTool(toolEvent)", receiptAt);

    expect(confirmAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeGreaterThan(confirmAt);
    expect(receiptAt).toBeGreaterThan(consumeAt);
    expect(executeAt).toBeGreaterThan(receiptAt);
    expect(source).toContain("Authorized. Tap Run to execute.");
    expect(source).toContain("executeTrustedActivationGatewayAction");
    expect(source).toContain("A new user turn supersedes any unconfirmed proposal");
    expect(source).toContain("setPendingAppAction(null);");
  });

  it("treats new voice intent as cancellation and requires a second run tap", () => {
    const source = fs.readFileSync(
      path.join(root, "components/agent/agent-bar.tsx"),
      "utf8",
    );

    expect(source).toContain('"superseded_by_new_turn"');
    expect(source).toContain('"superseded_by_new_directive"');
    expect(source).toContain("const needsConfirmation = true;");
    expect(source).toContain("Authorized. Tap Run to execute.");
    expect(source).toContain("if (!pending.receipt)");
    expect(source).toContain("confirmationTransport.confirmActionDirective({");
    expect(source).not.toContain("void confirmDirective({");
    expect(source).toContain("event.directive.delegateAgentId ?? null");
    expect(source).toContain("kind: event.directive.kind,");
  });
});
