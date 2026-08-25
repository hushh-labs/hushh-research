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
    expect(source).toContain('Authorized. Tap "${pending.event.label || "Run"}" to continue.');
    expect(source).toContain("executeTrustedActivationGatewayAction");
    expect(source).toContain("A new user turn supersedes any unconfirmed proposal");
    expect(source).toContain("setPendingAppAction(null);");
  });

  it("keeps voice confirmation fail-closed but executes after one spoken yes", () => {
    const source = fs.readFileSync(
      path.join(root, "components/agent/agent-bar.tsx"),
      "utf8",
    );

    // Supersession is named after whatever superseded it; the old
    // "superseded_by_new_turn" label is gone, so this asserted nothing. A new
    // turn must also tear down any standing journey approval: the person
    // approved one request, not whatever One decides to do next.
    expect(source).toContain('clearJourneyGrant("new_user_intent")');
    expect(source).toContain('"confirmation_superseded"');
    expect(source).toContain('"superseded_by_new_directive"');
    expect(source).toContain("event.directive.payload?.needsConfirmation !== false");
    expect(source).toContain("Say yes to run this, or no to cancel.");
    expect(source).toContain("settlePendingConfirmationRef.current(true);");
    expect(source).not.toContain("Allow access to complete this");
    expect(source).not.toContain(' : "Run"');
    expect(source).toContain("if (!pending.receipt)");
    expect(source).toContain("confirmationTransport.confirmActionDirective({");
    expect(source).not.toContain("void confirmDirective({");
    expect(source).toContain("event.directive.delegateAgentId ?? null");
    expect(source).toContain("kind: event.directive.kind,");
    const bindingCheck = source.indexOf("if (!directiveId || !contextRevision)");
    const supersession = source.indexOf('"superseded_by_new_directive"');
    expect(bindingCheck).toBeGreaterThan(-1);
    expect(supersession).toBeGreaterThan(bindingCheck);
  });
});
