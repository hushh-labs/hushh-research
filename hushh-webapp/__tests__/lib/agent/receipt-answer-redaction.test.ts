import { describe, expect, it } from "vitest";
import { RECEIPT_ANSWER_UNFINISHED_TEXT, retireReceiptAnswer } from "@/lib/agent/receipt-answer-redaction";

describe("retiring a receipt answer", () => {
  it("settles a turn still running, so it never streams forever with its outcome hidden", () => {
    // A redacted message takes no later updates; a vault or owner change mid-turn
    // used to leave it streaming with its timer running and no error or retry.
    const running = { text: "Partial", status: "streaming" as const, receiptPrivate: { ownerId: "owner" } };
    expect(retireReceiptAnswer(running)).toMatchObject({
      status: "done", text: RECEIPT_ANSWER_UNFINISHED_TEXT, receiptPrivate: undefined, receiptRedacted: true,
    });
    const failed = { text: "Partial", status: "error" as const, errorNotice: "Receipt authority changed. Ask again." };
    expect(retireReceiptAnswer(failed)).toMatchObject({ status: "error", text: "Receipt authority changed. Ask again." });
  });
});
