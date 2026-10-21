import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { SupportDeliveryUncertainError, SupportService } from "@/lib/services/support-service";
import { supportOutcomeToVoice } from "@/lib/profile/profile-action-outcomes";
import { NativeSupportFence, validNativeSupportProjection, type NativeSupportProjection } from "@/lib/capacitor/native-profile-support-scene";

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
    expect(source).toContain("<SegmentedControl");
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
    expect(source).not.toContain("userEmail:");
    expect(source).toContain("Replies go to");

    expect(source).not.toContain("Sent in test mode to");
    expect(source).not.toContain("result.recipient");
    expect(source).not.toContain("delivery_mode");
    expect(source).not.toContain("Support inbox");
  });

  it("uses inline validation, preserves the draft, and shows one completion state", () => {
    const source = profileSource();

    expect(source).toContain("supportMessageRef.current?.focus()");
    expect(source).toContain("Write at least 10 characters.");
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
    for (const kind of ["no_user", "busy", "too_short", "offline", "rejected", "accepted", "failed"]) {
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

describe("Support delivery receipt", () => {
  const request = {
    idToken: "test-token",
    userId: "test-owner",
    kind: "bug_report" as const,
    subject: "Synthetic issue",
    message: "Synthetic issue details",
  };

  it("reports a dropped response as uncertain instead of inviting a duplicate send", async () => {
    const fetch = vi.spyOn(ApiService, "apiFetch").mockRejectedValueOnce(new Error("connection lost"));
    await expect(SupportService.submitMessage(request)).rejects.toBeInstanceOf(SupportDeliveryUncertainError);
    fetch.mockRestore();
    expect(supportOutcomeToVoice({ kind: "uncertain" })).toEqual({
      status: "failed", summary: "Delivery could not be confirmed. Please wait before trying again.",
    });
  });

  it("only accepts an explicit provider-accepted receipt", async () => {
    const fetch = vi.spyOn(ApiService, "apiFetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ accepted: true, delivery_status: "accepted_by_provider", kind: "bug_report" }),
      { status: 200 },
    ));
    await expect(SupportService.submitMessage(request)).resolves.toMatchObject({ accepted: true });
    fetch.mockRestore();
  });
});

describe("Private native support scene", () => {
  const state = (): NativeSupportProjection => ({
    documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1,
    family: "profile", scene: "support", destinationId: "public-support-visit", updateSequence: 1, privacyGeneration: 2,
    draftRevision: 0, acknowledgedEditRevision: 0, draft: { kind: "bug_report", message: "Synthetic report only" },
    appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", canSave: true, busy: false, sent: false,
    error: null, replyLine: "Replies go to your verified account", placeholder: "What happened?", submitLabel: "Send report",
    successTitle: "Report sent", successDescription: "Thanks for your report.",
  });
  it("rejects credential-shaped fields and stale/duplicate Send while accepting the current acknowledged edit", async () => {
    const initial = state();
    expect(validNativeSupportProjection(initial)).toBe(true);
    expect(validNativeSupportProjection({ ...initial, vaultKey: "never admitted" } as NativeSupportProjection)).toBe(false);
    expect(validNativeSupportProjection({ ...initial, draft: { ...initial.draft, token: "never admitted" } } as NativeSupportProjection)).toBe(false);
    const fence = new NativeSupportFence(initial);
    expect(fence.update(initial)).toBe(true);
    const metadata = { documentId: initial.documentId, ownerEpoch: initial.ownerEpoch, ownerGeneration: initial.ownerGeneration,
      revision: initial.revision, family: initial.family, scene: initial.scene, destinationId: initial.destinationId,
      privacyGeneration: initial.privacyGeneration, updateSequence: initial.updateSequence, editRevision: 1 };
    const event = { ...metadata, composing: false, draft: { kind: "support_request" as const, message: "A different synthetic message" } };
    expect(fence.consumeEdit(event)).toBe(true);
    const action = { ...metadata, sequence: 1, action: "save" as const };
    const confirm = vi.fn().mockResolvedValue({ valid: true });
    expect(await fence.consumeAction(action, confirm, () => true)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    const next = { ...initial, updateSequence: 2, draftRevision: 1, acknowledgedEditRevision: 1, draft: event.draft };
    expect(fence.update(next)).toBe(true);
    const current = { ...action, updateSequence: 2 };
    expect(fence.allows({ ...current, destinationId: "other-visit" })).toBe(false);
    expect(fence.allows({ ...current, privacyGeneration: 3 })).toBe(false);
    expect(await fence.consumeAction(current, confirm, () => true)).toBe(true);
    expect(await fence.consumeAction(current, confirm, () => true)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    fence.retire();
    expect(fence.consumeEdit({ ...event, editRevision: 2 })).toBe(false);
  });
});
