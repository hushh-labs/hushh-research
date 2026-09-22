import { describe, expect, it } from "vitest";
import { mailDisplayLabel } from "@/lib/copy/mail-terminology";
import { humanizeMemorySegment } from "@/lib/pkm/humanize-segment";
import { humanizeConsentScope } from "@/lib/consent/consent-display";
import { getKaiActionById, searchKaiActions } from "@/lib/voice/kai-action-gateway";

describe("Mail presentation vocabulary", () => {
  it.each([
    ["Email", "Mail"], ["Gmail", "Mail"],
    ["Connect Gmail", "Connect Mail"], ["Emails checked", "Mail messages checked"],
    ["Open email", "Open mail"], ["Your Gmail account", "Your Mail account"],
  ])("presents %s as %s", (input, expected) => {
    expect(mailDisplayLabel(input)).toBe(expected);
  });

  it.each(["person@gmail.com", "email@example.test", "/one/gmail", "agent_email", "google_email", "https://mail.google.com", "https://www.googleapis.com/auth/gmail.readonly"])("preserves technical value %s", value => {
    expect(mailDisplayLabel(value)).toBe(value);
  });

  it("changes generated field captions without changing their source scopes", () => {
    const scope = "attr.identity.email";
    expect(humanizeConsentScope(scope)).toBe("Identity Mail");
    expect(scope).toBe("attr.identity.email");
    expect(humanizeMemorySegment("workEmailAddress")).toBe("Work Mail Address");
    expect(humanizeMemorySegment("gmail_receipts")).toBe("Mail Receipts");
  });

  it("keeps the action contract intact while accepting the displayed Mail search label", () => {
    const action = getKaiActionById("profile.gmail.connect");
    expect(action?.label).toBe("Connect Gmail");
    expect(mailDisplayLabel(action?.label ?? "")).toBe("Connect Mail");
    expect(action?.action_id).toBe("profile.gmail.connect");
    expect(searchKaiActions({ query: "Connect Mail", limit: 40 }).some(({ action }) => action.action_id === "profile.gmail.connect")).toBe(true);
  });
});
