import { describe, expect, it, vi } from "vitest";
import { nativeMemoryCapture, nativeMemoryCaptureEditor, type NativeMemoryCaptureModel } from "@/components/profile/native-memory-capture";

function fixture(overrides: Partial<NativeMemoryCaptureModel> = {}): NativeMemoryCaptureModel {
  return {
    captureText: "A synthetic preference.",
    identifierProcessingApproved: () => false,
    setIdentifierProcessingApproval: vi.fn(),
    captureCards: [], domainTitles: new Map(), captureMessage: null,
    captureLoading: false, captureSaving: false, captureHasUnresolvedSource: false,
    captureUnresolvedSections: [], captureSourceSnapshot: "", captureRetryingSectionKey: null,
    retryCaptureSection: vi.fn(), captureHasSharedRecipients: false,
    captureSharingImpactAcknowledged: false, setCaptureSharingImpactAcknowledged: vi.fn(),
    captureSaveableCards: [], previewMemoryCapture: vi.fn(), saveMemoryCapture: vi.fn(),
    changeCaptureText: vi.fn(), captureInputRevision: () => 4, captureSessionCurrent: () => true, ...overrides,
  } as unknown as NativeMemoryCaptureModel;
}

describe("native Memory capture projection", () => {
  it("keeps note editing available during review, while fencing identifier approval and review", () => {
    const model = fixture({ captureLoading: true });
    const projection = nativeMemoryCapture(model, key => `opaque-${key}`)!;
    expect(projection.busy).toBe(false);
    expect(projection.reviewing).toBe(true);
    expect(projection.canToggleIdentifier).toBe(false);
    expect(projection.canReview).toBe(false);
    projection.applyDraft({ text: "new synthetic text", identifierApproved: true });
    expect(model.changeCaptureText).toHaveBeenCalledWith("new synthetic text");
    expect(model.setIdentifierProcessingApproval).not.toHaveBeenCalled();
  });

  it("grants identifier approval only against the unchanged current note", () => {
    const model = fixture();
    const projection = nativeMemoryCapture(model, key => `opaque-${key}`)!;
    projection.applyDraft({ text: model.captureText, identifierApproved: true });
    expect(model.changeCaptureText).not.toHaveBeenCalled();
    expect(model.setIdentifierProcessingApproval).toHaveBeenCalledWith(true);
  });

  it("rejects old-owner, stale-revision and combined text-plus-consent editor events", () => {
    const model = fixture();
    const projection = nativeMemoryCapture(model, key => `opaque-${key}`)!;
    const editor = nativeMemoryCaptureEditor(model, projection, "destination", () => true);
    expect(editor.changeDraft({ text: "changed", identifierApproved: true }, 4)).toBe(false);
    expect(editor.changeDraft({ text: "changed", identifierApproved: false }, 3)).toBe(false);
    expect(model.changeCaptureText).not.toHaveBeenCalled();
    expect(model.setIdentifierProcessingApproval).not.toHaveBeenCalled();
    expect(editor.changeDraft({ text: "changed", identifierApproved: false }, 4)).toBe(true);
    expect(model.changeCaptureText).toHaveBeenCalledWith("changed");
    const retired = nativeMemoryCaptureEditor(fixture({ captureSessionCurrent: () => false }), projection, "destination", () => true);
    expect(retired.changeDraft({ text: "changed again", identifierApproved: false }, 4)).toBe(false);
  });

  it("preserves reviewed source and prevents sharing-sensitive save without acknowledgement", () => {
    const card = {
      card_id: "private-record-id", source_text: "A synthetic preference.", write_mode: "confirm_first",
      target_domain: "travel", target_entity_scope: "preferences",
      sharing_impact: { active_recipient_count: 1, summary: "This detail is already shared." },
    } as unknown as NativeMemoryCaptureModel["captureCards"][number];
    const model = fixture({ captureCards: [card], captureSaveableCards: [card], captureHasSharedRecipients: true });
    const projection = nativeMemoryCapture(model, key => `opaque-${key}`)!;
    const rows = projection.sections.flatMap(section => section.rows);
    expect(rows.find(row => row.label === "A synthetic preference.")?.detail).toContain("This detail is already shared.");
    expect(rows.find(row => row.label === "Save to Memory")?.enabled).toBe(false);
    const ack = rows.find(row => row.id === "opaque-memory-capture:sharing-ack")!;
    projection.actions.get(ack.id)?.();
    expect(model.setCaptureSharingImpactAcknowledged).toHaveBeenCalledWith(true);
    expect(JSON.stringify(projection.sections)).not.toContain("private-record-id");

    const approved = nativeMemoryCapture(fixture({ ...model, captureSharingImpactAcknowledged: true }), key => `opaque-${key}`)!;
    expect(approved.sections.flatMap(section => section.rows).find(row => row.label === "Save to Memory")?.enabled).toBe(true);
  });

  it("uses the complete React handoff when content exceeds bridge bounds", () => {
    const card = { card_id: "1", source_text: "x".repeat(4097), write_mode: "confirm_first" } as unknown as NativeMemoryCaptureModel["captureCards"][number];
    expect(nativeMemoryCapture(fixture({ captureCards: [card] }), key => `opaque-${key}`)).toBeNull();
    expect(nativeMemoryCapture(fixture({ captureText: "x".repeat(50_001) }), key => `opaque-${key}`)).toBeNull();
  });
});
