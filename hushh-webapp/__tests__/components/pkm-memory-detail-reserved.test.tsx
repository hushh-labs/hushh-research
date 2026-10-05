import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PkmMemoryDetail } from "@/components/profile/pkm-memory-detail";
import { buildPkmMemoryCardsFromNode } from "@/lib/pkm/pkm-memory-cards";

afterEach(cleanup);

/**
 * The Memory tab under memory_screen_policy read_only_reserved: an item in an
 * app-owned branch is read-only here and opens the owning screen, where its
 * own writer edits or removes it. Items in agent_memory siblings stay editable.
 */
function detail(domain: string, value: unknown, onOpenOwner = vi.fn()) {
  const [card] = buildPkmMemoryCardsFromNode({
    domain,
    domainTitle: domain,
    value,
    sourceLabel: "Saved memory",
    updatedAt: null,
    pathSegments: [],
  });
  render(
    <PkmMemoryDetail
      card={card!}
      sharingState="private"
      sharingPosture="private"
      sharingBusy={false}
      sharingError={null}
      canMutate={card!.editable}
      saving={false}
      deleting={false}
      actionError={null}
      onBack={vi.fn()}
      onSharingChange={vi.fn()}
      onSave={vi.fn()}
      onForget={vi.fn()}
      onOpenOwner={onOpenOwner}
    />,
  );
  return onOpenOwner;
}

describe("Memory detail for an app-owned item", () => {
  it("preserves the full multiline value when an editable routed note is corrected", () => {
    const value = "First line\nSecond line " + "Full note ".repeat(30);
    const [card] = buildPkmMemoryCardsFromNode({ domain: "location", domainTitle: "Location", value, sourceLabel: "Saved memory", updatedAt: null, pathSegments: ["agent_memory", "note"] });
    const onSave = vi.fn();
    render(<PkmMemoryDetail card={card!} displayLabel="Note" displayValue={value} sharingState="private" sharingPosture="private" sharingBusy={false} sharingError={null} canMutate saving={false} deleting={false} actionError={null} onBack={vi.fn()} onSharingChange={vi.fn()} onSave={onSave} onForget={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const editor = screen.getByRole("textbox", { name: "New value for Note" });
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor).toHaveValue(value);
    const corrected = value.replace("First", "Corrected");
    fireEvent.change(editor, { target: { value: corrected } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(onSave).toHaveBeenCalledWith(corrected);
  });

  it("is read-only and opens the owning app instead", () => {
    const onOpenOwner = detail("location", { saved_places: { home: { label: "Home" } } });
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Forget Memory")).toBeNull();
    expect(screen.getByTestId("memory-detail-reserved-note")).toHaveTextContent(
      "Location manages this. Edit or remove it there.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in Location" }));
    expect(onOpenOwner).toHaveBeenCalledWith("/one/location");
  });

  it("keeps Edit and Forget on an agent_memory item (negative control)", () => {
    detail("location", { agent_memory: { entities: { mem_1: { summary: "Near the lake" } } } });
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Forget Memory")).toBeTruthy();
    expect(screen.queryByText("Open in Location")).toBeNull();
  });
});

describe("Memory detail for an identity item", () => {
  it.each([
    ["identity", { identity_profile: { legal_name: "Ada Lovelace" } }],
    ["identity", { identity_documents: { passport: { issuing_country: "GB" } } }],
    ["professional", { profile: { title: "Analyst" } }],
  ] as const)("%s opens Mail's KYC tab: %j", (domain, value) => {
    const onOpenOwner = detail(domain, value);
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.getByTestId("memory-detail-reserved-note")).toHaveTextContent(
      "Mail manages this. Edit or remove it there.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in Mail" }));
    expect(onOpenOwner).toHaveBeenCalledWith("/one/gmail?workspace=kyc");
  });

  it("keeps an identity agent_memory item editable, with no Open in (negative control)", () => {
    detail("identity", { agent_memory: { entities: { mem_1: { summary: "Prefers a middle initial" } } } });
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.queryByText("Open in Mail")).toBeNull();
  });
});
