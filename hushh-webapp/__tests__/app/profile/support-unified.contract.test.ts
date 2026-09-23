import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profileSource = () =>
  readFileSync(
    join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
    "utf8",
  );

describe("Profile Help & feedback unified support flow", () => {
  it("renders one unified support interface instead of three duplicate entry rows", () => {
    const source = profileSource();

    expect(source).toContain("const SUPPORT_INTENT_PRESENTATION");
    expect(source).toContain('label: "Problem"');
    expect(source).toContain('label: "Help"');
    expect(source).toContain('label: "Feedback"');
    expect(source).toContain("<SegmentedTabs");
    expect(source).toContain("What do you need?");

    expect(source).not.toContain("const supportActions");
    expect(source).not.toContain('title="Support routing"');
    expect(source).not.toContain('placeholder="Subject"');
    expect(source).not.toContain("setSupportSubject");
    expect(source).not.toContain("openSupportComposer");
  });

  it("keeps internal kind mapping and generated subjects without exposing delivery routing", () => {
    const source = profileSource();

    expect(source).toContain('internalSubject: "Bug report"');
    expect(source).toContain('internalSubject: "Support request"');
    expect(source).toContain('internalSubject: "Developer feedback"');
    expect(source).toContain("subject: presentation.internalSubject");
    expect(source).toMatch(
      /useState<SupportMessageKind>\(\s*"support_request"\s*\)/,
    );
    expect(source).toContain(
      "userEmail: user.email?.trim() || trimmedReplyEmail || null",
    );

    expect(source).not.toContain("Sent in test mode to");
    expect(source).not.toContain("result.recipient");
    expect(source).not.toContain("delivery_mode");
    expect(source).not.toContain("Support inbox");
  });

  it("uses inline validation, preserves the draft, and shows one completion state", () => {
    const source = profileSource();

    expect(source).toContain("supportMessageRef.current?.focus()");
    expect(source).toContain("Add a few more details.");
    expect(source).toContain('role="alert"');
    expect(source).toContain('supportComposerState.status === "sent"');
    expect(source).toContain("supportSuccessHeadingRef.current?.focus()");
    expect(source).toContain('id="support-success-heading"');
    expect(source).toContain("Replies go to");
  });
});

describe("Profile support voice settlement", () => {
  // Graph observation 6: the local voice wrapper returned "succeeded" after
  // submitSupportMessage early-returned on validation/offline or caught an
  // error. Only the service's accepted result may be narrated as sent.
  const source = readFileSync(
    join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
    "utf8",
  );

  it("submitSupportMessage returns a typed outcome from every exit", () => {
    expect(source).toContain(
      "async function submitSupportMessage(\n    messageOverride?: string,\n  ): Promise<SupportSubmitOutcome>",
    );
    for (const kind of ["no_user", "busy", "too_short", "invalid_reply_email", "offline", "rejected", "accepted", "failed"]) {
      expect(source).toContain(`return { kind: "${kind}" };`);
    }
    // No bare early return remains inside the function body.
    const body = source.slice(
      source.indexOf("async function submitSupportMessage("),
      source.indexOf("async function handleDisconnectGmail()"),
    );
    expect(body).not.toMatch(/\n\s*return;\n/);
  });

  it("the voice wrapper narrates that outcome, never an unconditional 'sent'", () => {
    expect(source).toContain("const outcome = await submitSupportMessage(message);");
    expect(source).toContain("return supportOutcomeToVoice(outcome);");
    expect(source).not.toContain(
      'await submitSupportMessage(message);\n      return { status: "succeeded" as const, summary: "Sent that to support." };',
    );
  });
});
