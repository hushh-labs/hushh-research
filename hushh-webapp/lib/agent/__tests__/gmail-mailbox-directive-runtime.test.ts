import { describe, expect, it, vi } from "vitest";

import { runGmailMailboxDirective } from "@/lib/agent/gmail-mailbox-directive-runtime";
import { EmailDeliveryService } from "@/lib/services/email-delivery-service";

vi.mock("@/lib/services/email-delivery-service", () => ({
  EmailDeliveryService: { executeMailboxProposal: vi.fn() },
}));

const auth = { firebaseIdToken: "firebase", vaultOwnerToken: "HCT:test" };

describe("runGmailMailboxDirective", () => {
  it("executes only the reviewed proposal id and reports the outcome per action", async () => {
    vi.mocked(EmailDeliveryService.executeMailboxProposal).mockResolvedValue({
      action: "add_label",
      count: 2,
    });

    const result = await runGmailMailboxDirective(
      {
        kind: "action",
        payload: {
          type: "gmail.execute_mailbox_proposal",
          proposalId: "gmod_example",
          action: "add_label",
          label: "Receipts",
          messages: [{ subject: "Invoice" }],
        },
      },
      auth,
    );

    expect(EmailDeliveryService.executeMailboxProposal).toHaveBeenCalledWith({
      ...auth,
      proposalId: "gmod_example",
    });
    expect(result).toMatchObject({
      delegate_agent_id: "agent_email",
      status: "completed",
      detail: "Added the label “Receipts” to 2 emails.",
    });
  });

  it("never reaches Gmail for a directive that is not a reviewed proposal", async () => {
    vi.mocked(EmailDeliveryService.executeMailboxProposal).mockClear();
    for (const payload of [
      { type: "gmail.connect", purpose: "modify" },
      { type: "gmail.execute_mailbox_proposal", action: "trash" },
      { type: "gmail.execute_mailbox_proposal", proposalId: "gmod_x", action: "delete" },
    ]) {
      await expect(runGmailMailboxDirective({ kind: "action", payload }, auth)).rejects.toThrow(
        "Mailbox confirmation is invalid",
      );
    }
    expect(EmailDeliveryService.executeMailboxProposal).not.toHaveBeenCalled();
  });
});
