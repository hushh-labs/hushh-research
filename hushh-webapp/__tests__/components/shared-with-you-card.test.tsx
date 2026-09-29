import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The secure "Shared with you" card (CONTRACT-2 decisions 1 and 2, C6):
 * every state it can be in, the chat wiring from the backend's own card
 * payload, and opening an item that names no bundle.
 */
const mocks = vi.hoisted(() => ({
  user: { uid: "requester-1", getIdToken: vi.fn(async () => "id-token") },
  unlocked: true,
  getInformationRequest: vi.fn(),
  getInformationRequestExports: vi.fn(),
  listSharedWithMe: vi.fn(),
  readStoredConnector: vi.fn(),
  decryptScopedExport: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/lib/services/agent-chat-client", () => ({ getAgentChatConsentOutcomes: vi.fn(async () => ({})) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultKey: mocks.unlocked ? "vault-key" : null,
    vaultOwnerToken: mocks.unlocked ? "owner-token" : null }),
}));
vi.mock("@/lib/services/person-profile-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/person-profile-service")>()),
  PersonProfileService: {
    getInformationRequest: mocks.getInformationRequest,
    getInformationRequestExports: mocks.getInformationRequestExports,
    listSharedWithMe: mocks.listSharedWithMe,
    getViewer: vi.fn(),
  },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {
  readStoredConnector: mocks.readStoredConnector,
  decryptScopedExport: mocks.decryptScopedExport,
} }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open, title }: { open: boolean; title: string }) =>
    open ? <div role="dialog" aria-label={title} /> : null,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button>,
}));

import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import {
  SharedWithYouCardView,
  sharedValueRows,
  type SharedWithYouItemView,
} from "@/components/agent/consent/shared-with-you-card-view";
import {
  normalizeSharedItems,
  SHARED_OPEN_TIMEOUT_MS,
  SharedWithYouCard,
} from "@/components/agent/consent/shared-with-you-card";
import type { SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { readInformationRequest, readSharedWithMe } from "@/lib/consent/information-request-reads";
import { liveAccessWatchSnapshot } from "@/lib/consent/live-access-watch";
import { clearSentInformationRequests } from "@/lib/agent/consent-continuation";
import { onePerPersonSharedCard } from "@/components/agent/agent-turn-stream-panel";
import {
  parseAgentActivityExperience,
  parseAgentToolResultExperience,
  type SharedWithMeCardExperience,
} from "@/lib/agent/agui-structured-experiences";

const PERSON = "manish_public_ref_0001";
const BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const TAX_REQUEST = "request_tax_00000001";
const TAX_VALUES = { filing_year: 2024, adjusted_gross_income: 85000, filing_status: "Married filing jointly" };

/** Exactly what `list_information_shared_with_me` returns (shared_with_me_card.py). */
const BACKEND_RESULT = {
  status: "ok",
  person: { displayName: "Manish Sainani", personRef: PERSON },
  kind: "one.shared_with_me_card.v1",
  cards: [{
    kind: "one.shared_with_me_card.v1",
    person: { personRef: PERSON, displayName: "Manish Sainani", profilePath: `/people/${PERSON}` },
    items: [{
      grantRef: TAX_REQUEST, requestId: TAX_REQUEST, bundleId: BUNDLE,
      label: "Tax Record Domain", sensitivity: "sensitive",
      fieldOutline: ["Filing year", "Adjusted gross income", "Filing status"],
      sharedAt: "2026-09-28T10:00:00Z", accessEndsAt: "2099-10-05T12:00:00Z",
      purpose: "Preparing the joint return", decryptable: true,
    }],
    decryptVia: "information_request_exports",
  }],
  count: 1,
  nextStep: "Reply in one short line.",
};

function exportFor(requestId: string, scope: string) {
  return {
    requestId, scopeRef: "scope-tax",
    encryptedExport: {
      request_id: requestId, scope, export_revision: 1,
      export_envelope: { version: 2, export_id: `export-${requestId}`, aad: {
        version: 2, app_id: "agent_one", grant_id: requestId, export_id: `export-${requestId}`,
        revision: 1, machine_scope: scope, payload_algorithm: "AES-256-GCM",
        expires_at_ms: Date.now() + 3_600_000,
      } },
    },
  };
}

function grantedBundle(status: "granted" | "revoked" = "granted") {
  return {
    bundleId: BUNDLE, personRef: PERSON, purpose: "Preparing the joint return", durationSeconds: 604800,
    cancelled: false,
    items: [{ requestId: TAX_REQUEST, scopeRef: "scope-tax", label: "Tax record", sensitivity: "sensitive", status }],
  };
}

function item(overrides: Partial<SharedWithYouItemView> = {}): SharedWithYouItemView {
  return {
    key: "tax", label: "Tax record", sharedAt: "2026-09-28T10:00:00Z", accessEndsAt: "2026-10-05T12:00:00Z",
    purpose: "Preparing the joint return", sensitive: true,
    fieldOutline: ["Filing year", "Adjusted gross income"], state: "ready", data: TAX_VALUES,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSentInformationRequests(null);
  mocks.unlocked = true;
  mocks.readStoredConnector.mockResolvedValue({ connector_key_id: "ck_1" });
  mocks.getInformationRequest.mockResolvedValue(grantedBundle());
  mocks.getInformationRequestExports.mockResolvedValue([exportFor(TAX_REQUEST, "attr.financial.tax_record.*")]);
  mocks.decryptScopedExport.mockResolvedValue(TAX_VALUES);
  mocks.listSharedWithMe.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe("the card's states", () => {
  const person = { displayName: "Manish Sainani" };

  it("loading draws the final rows as a skeleton, with no values", () => {
    render(<SharedWithYouCardView person={person} status="loading" items={[item({ state: "loading", data: null })]} />);
    const outline = screen.getByTestId("shared-with-you-loading-outline");
    expect(outline).toHaveAttribute("aria-busy", "true");
    expect(within(outline).getByText("Filing year")).toBeInTheDocument();
    expect(screen.getByTestId("shared-with-you-secure")).toHaveTextContent("Opening on this device");
    expect(screen.queryByTestId("shared-with-you-values")).toBeNull();
  });

  it("locked shows the field names and an inline Unlock to view, never a value", () => {
    const onUnlock = vi.fn();
    render(<SharedWithYouCardView person={person} status="locked" onUnlock={onUnlock}
      items={[item({ state: "locked", data: null })]} />);
    expect(within(screen.getByTestId("shared-with-you-locked-outline")).getByText("Adjusted gross income")).toBeInTheDocument();
    expect(screen.queryByText("85000")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlock to view" }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("a sensitive item shows its values at once, hides on request, and copies one value", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SharedWithYouCardView person={person} status="ready" items={[item()]} />);
    expect(screen.getByTestId("shared-with-you-secure")).toHaveTextContent("Decrypted on this device");
    expect(screen.getByTestId("shared-with-you-sensitive")).toHaveTextContent("Sensitive · not shared with One’s model");
    expect(screen.getByText("Shared Sep 28 · Access until Oct 5")).toBeInTheDocument();
    expect(screen.getByTestId("shared-with-you-values")).toHaveTextContent("85000");

    fireEvent.click(screen.getByRole("button", { name: "Copy Adjusted gross income" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("85000"));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied", expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: "Hide Tax record" }));
    expect(screen.getByTestId("shared-with-you-values")).toHaveAttribute("data-hidden", "true");
    expect(screen.queryByText("85000")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Tax record" }));
    expect(screen.getByText("85000")).toBeInTheDocument();
  });

  // Localhost run 4 (S3): an EIN inside a standard "Legal entity" item read
  // like any other field. It is marked Sensitive and Hide masks it alone.
  it("marks an identifier field inside a standard item and hides only that field", () => {
    const legal = item({
      key: "legal", label: "Legal entity", sensitive: false, fieldOutline: ["Federal EIN", "Trade name", "Registered agent"],
      data: { fein: "12-3456789", trade_name: "Acme Coffee", registered_agent: "Jordan Lee" },
      fields: [{ name: "Registered agent", sensitivity: "sensitive" }, { name: "Trade name", sensitivity: "standard" }],
    });
    render(<SharedWithYouCardView person={person} status="ready" items={[legal]} />);
    expect(screen.queryByTestId("shared-with-you-sensitive")).toBeNull();
    const marked = screen.getAllByTestId("shared-with-you-sensitive-field");
    expect(marked).toHaveLength(2);
    expect(marked[0]!.closest("[data-testid='shared-with-you-row']")).toHaveTextContent("Federal EIN");
    fireEvent.click(screen.getByRole("button", { name: "Hide Legal entity" }));
    expect(screen.queryByText("12-3456789")).toBeNull();
    expect(screen.queryByText("Jordan Lee")).toBeNull();
    expect(screen.getByText("Acme Coffee")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Trade name" })).toBeInTheDocument();
    cleanup();
    // Negative control: an ordinary standard item carries no mark and no Hide.
    render(<SharedWithYouCardView person={person} status="ready"
      items={[item({ key: "food", label: "Food preferences", sensitive: false, data: { cuisine: "Neapolitan pizza" } })]} />);
    expect(screen.queryByTestId("shared-with-you-sensitive-field")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Hide/ })).toBeNull();
  });

  it("splits a record into field and value rows with no internal keys", () => {
    const rows = sharedValueRows({ ...TAX_VALUES, mem_65725402299c: { id: "x" }, __export_metadata: { scope: "attr.tax" } }, "Tax record");
    expect(rows).toEqual([
      { label: "Filing year", value: "2024" },
      { label: "Adjusted gross income", value: "85000" },
      { label: "Filing status", value: "Married filing jointly" },
    ]);
  });

  it("ended access says so calmly and shows nothing that was shared", () => {
    render(<SharedWithYouCardView person={person} status="ready"
      items={[item({ state: "ended", endedReason: "revoked", data: null })]} />);
    expect(screen.getByTestId("access-ended-notice"))
      .toHaveTextContent("Manish stopped sharing Tax record. One no longer uses it.");
    expect(screen.queryByTestId("shared-with-you-values")).toBeNull();
  });

  it("an error offers one calm retry", () => {
    const onRetry = vi.fn();
    render(<SharedWithYouCardView person={person} status="error" onRetry={onRetry} items={[item({ state: "loading" })]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("What Manish shared couldn’t be opened.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("the card in chat, from the backend's C6 result", () => {
  function experience(): SharedWithMeCardExperience {
    const parsed = parseAgentToolResultExperience("list_information_shared_with_me", BACKEND_RESULT);
    if (parsed?.type !== "one.shared_with_me_card.v1") throw new Error("the C6 fixture did not parse");
    return parsed;
  }

  it("reads the backend payload: one card, a human label, the outline and the refs", () => {
    const card = experience().cards[0]!;
    expect(card.person).toMatchObject({ personRef: PERSON, displayName: "Manish Sainani" });
    expect(card.items[0]).toMatchObject({
      grantRef: TAX_REQUEST, requestId: TAX_REQUEST, bundleId: BUNDLE, label: "Tax record", sensitivity: "sensitive",
      fieldOutline: ["Filing year", "Adjusted gross income", "Filing status"],
    });
    // History restores it as `{cards: [...]}` through the activity registry, the same parser.
    const restored = parseAgentActivityExperience("one.shared_with_me_card.v1", { cards: BACKEND_RESULT.cards });
    expect(restored).toMatchObject({ type: "one.shared_with_me_card.v1", cards: [{ person: { personRef: PERSON } }] });
  });

  it("negative control: a share list without the card kind is not a card", () => {
    const { kind: _kind, cards: _cards, ...plain } = BACKEND_RESULT;
    expect(parseAgentToolResultExperience("list_information_shared_with_me", plain)?.type).not.toBe("one.shared_with_me_card.v1");
  });

  it("opens the values on this device and shows them right away", async () => {
    render(<AgentStructuredExperienceView experience={experience()} />);
    const values = await screen.findByTestId("shared-with-you-values");
    expect(values).toHaveTextContent("Married filing jointly");
    expect(screen.getByTestId("shared-with-you-sensitive")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Tax Record Domain|grant|scope/i);
    expect(mocks.getInformationRequestExports).toHaveBeenCalledWith({ bundleId: BUNDLE, vaultOwnerToken: "owner-token" });
  });

  it("with the vault locked, outlines the fields and opens in place after unlock", async () => {
    mocks.unlocked = false;
    const view = render(<AgentStructuredExperienceView experience={experience()} />);
    expect(screen.getByTestId("shared-with-you-card")).toHaveAttribute("data-status", "locked");
    expect(screen.getByText("Filing status")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlock to view" }));
    expect(screen.getByRole("dialog", { name: "Unlock to view" })).toBeInTheDocument();
    expect(mocks.decryptScopedExport).not.toHaveBeenCalled();

    mocks.unlocked = true;
    view.rerender(<AgentStructuredExperienceView experience={experience()} />);
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("85000");
  });

  it("drops the values the moment access ends", async () => {
    render(<AgentStructuredExperienceView experience={experience()} />);
    await screen.findByTestId("shared-with-you-values");
    mocks.getInformationRequest.mockResolvedValue(grantedBundle("revoked"));
    act(() => window.dispatchEvent(new Event("consent-state-changed")));
    expect(await screen.findByTestId("access-ended-notice")).toHaveTextContent("stopped sharing Tax record");
    expect(screen.queryByText("85000")).toBeNull();
  });
});

describe("what the server says cannot be opened, or says nothing about", () => {
  it("decryptable false shows the outline and a calm line, and opens nothing", async () => {
    render(<SharedWithYouCard person={{ personRef: PERSON, displayName: "Manish Sainani" }} items={[{
      key: TAX_REQUEST, grantRef: TAX_REQUEST, bundleId: null, requestId: TAX_REQUEST, label: "Tax record information",
      sensitivity: "sensitive", domain: null, fieldOutline: ["Filing year"], sharedAt: null, accessEndsAt: null,
      purpose: null, status: null, decryptable: false,
    }]} />);
    expect(screen.getByText("Can’t be opened on this device.")).toBeInTheDocument();
    expect(screen.getByText("Filing year")).toBeInTheDocument();
    expect(screen.getByText("Tax record information")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(mocks.getInformationRequest).not.toHaveBeenCalled();
    expect(mocks.listSharedWithMe).not.toHaveBeenCalled();
  });

  it("an item with no sensitivity reads as sensitive", () => {
    mocks.unlocked = false;
    render(<SharedWithYouCard person={{ personRef: PERSON, displayName: "Manish Sainani" }} items={[{
      key: "food", grantRef: "request_food_0001", bundleId: BUNDLE, requestId: "request_food_0001", label: "Food preferences",
      sensitivity: null, domain: null, fieldOutline: [], sharedAt: null, accessEndsAt: null, purpose: null, status: null,
    }]} />);
    expect(screen.getByTestId("shared-with-you-sensitive")).toBeInTheDocument();
  });
});

describe("an item that names no bundle", () => {
  it("resolves through the current share list, then opens that bundle's item only", async () => {
    mocks.listSharedWithMe.mockResolvedValue([
      { bundleId: BUNDLE, requestId: TAX_REQUEST, person: "Manish Sainani", personRef: PERSON,
        profilePath: null, label: "Tax record", purpose: null, expiresAt: null },
      { bundleId: "someone-else", requestId: TAX_REQUEST, person: "Another Person", personRef: "another_public_ref_01",
        profilePath: null, label: "Tax record", purpose: null, expiresAt: null },
    ]);
    render(<SharedWithYouCard person={{ personRef: PERSON, displayName: "Manish Sainani" }} items={[{
      key: TAX_REQUEST, grantRef: TAX_REQUEST, bundleId: null, requestId: null, label: "Tax record",
      sensitivity: null, domain: null, fieldOutline: [], sharedAt: null, accessEndsAt: null, purpose: null, status: null,
    }]} />);
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("85000");
    expect(mocks.getInformationRequestExports).toHaveBeenCalledTimes(1);
    expect(mocks.getInformationRequestExports).toHaveBeenCalledWith({ bundleId: BUNDLE, vaultOwnerToken: "owner-token" });
  });

  it("with no live share to match, shows a calm retry and opens nothing", async () => {
    render(<SharedWithYouCard person={{ personRef: PERSON, displayName: "Manish Sainani" }} items={[{
      key: "orphan", grantRef: "request_orphan_0001", bundleId: null, requestId: null, label: "Tax record",
      sensitivity: null, domain: null, fieldOutline: [], sharedAt: null, accessEndsAt: null, purpose: null, status: null,
    }]} />);
    await waitFor(() => expect(screen.getByTestId("shared-with-you-card")).toHaveAttribute("data-status", "error"));
    expect(mocks.decryptScopedExport).not.toHaveBeenCalled();
  });
});

describe("one card per person in a turn", () => {
  it("keeps the last card for a person and every other experience", () => {
    const card = (id: string, refs: string[]) => ({ id, experience: {
      type: "one.shared_with_me_card.v1" as const,
      cards: refs.map((ref) => ({ person: { personRef: ref, displayName: ref, profilePath: null, photoUrl: null }, items: [], decryptVia: null })),
    } });
    const other = { id: "brief", experience: { type: "one.evidence_brief.v1" as const, title: "t", summary: "s",
      confidence: "high" as const, findings: [], sources: [], unresolved: [] } };
    const kept = onePerPersonSharedCard([card("list", ["manish", "kushal"]), other, card("show", ["manish"])]);
    expect(kept.map((entry) => entry.id)).toEqual(["list", "brief", "show"]);
    const first = kept[0]!.experience as SharedWithMeCardExperience;
    expect(first.cards.map((entry) => entry.person.personRef)).toEqual(["kushal"]);
  });
});

function taxItem(overrides: Partial<SharedWithMeCardItem> = {}): SharedWithMeCardItem {
  return {
    key: TAX_REQUEST, grantRef: TAX_REQUEST, bundleId: BUNDLE, requestId: TAX_REQUEST, label: "Tax record",
    sensitivity: "sensitive", domain: null, fieldOutline: ["Filing year"], sharedAt: "2026-09-28T10:00:00Z",
    accessEndsAt: null, purpose: null, status: "granted", ...overrides,
  };
}
const MANISH = { personRef: PERSON, displayName: "Manish Sainani" };

// Run 4 (R3, R8): the card dropped its open on every state change, so an
// open needing three slow reads never finished ("Opening on this device…"
// for over 20 minutes).
describe("opening is idempotent and survives re-renders", () => {
  it("completes one open across re-renders and unrelated consent events", async () => {
    let releaseExports: (value: unknown) => void = () => undefined;
    mocks.getInformationRequestExports.mockReturnValue(new Promise((resolve) => { releaseExports = resolve; }));
    const view = render(<SharedWithYouCard person={MANISH} items={[taxItem()]} />);
    await waitFor(() => expect(mocks.getInformationRequestExports).toHaveBeenCalledTimes(1));
    // A parent re-render with a new array of the same items, twice, and a
    // consent event about something else entirely.
    view.rerender(<SharedWithYouCard person={MANISH} items={[taxItem()]} />);
    view.rerender(<SharedWithYouCard person={MANISH} items={[{ ...taxItem() }]} />);
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: { source: "feed_actionable" } })));
    await act(async () => { releaseExports([exportFor(TAX_REQUEST, "attr.financial.tax_record.*")]); });
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("Married filing jointly");
    expect(mocks.getInformationRequestExports).toHaveBeenCalledTimes(1);
    expect(mocks.decryptScopedExport).toHaveBeenCalledTimes(1);
  });

  it("control: a lock is a real change, and the open it interrupted never shows", async () => {
    let releaseExports: (value: unknown) => void = () => undefined;
    mocks.getInformationRequestExports.mockReturnValue(new Promise((resolve) => { releaseExports = resolve; }));
    const view = render(<SharedWithYouCard person={MANISH} items={[taxItem()]} />);
    await waitFor(() => expect(mocks.getInformationRequestExports).toHaveBeenCalledTimes(1));
    mocks.unlocked = false;
    view.rerender(<SharedWithYouCard person={MANISH} items={[taxItem()]} />);
    await act(async () => { releaseExports([exportFor(TAX_REQUEST, "attr.financial.tax_record.*")]); });
    expect(screen.getByTestId("shared-with-you-card")).toHaveAttribute("data-status", "locked");
    expect(screen.queryByText("Married filing jointly")).toBeNull();
  });

  it("a stalled open shows a calm retry, and the late result still lands", async () => {
    vi.useFakeTimers();
    try {
      let releaseExports: (value: unknown) => void = () => undefined;
      mocks.getInformationRequestExports.mockReturnValue(new Promise((resolve) => { releaseExports = resolve; }));
      render(<SharedWithYouCard person={MANISH} items={[taxItem()]} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId("shared-with-you-card")).toHaveAttribute("data-status", "loading");
      await act(async () => { await vi.advanceTimersByTimeAsync(SHARED_OPEN_TIMEOUT_MS); });
      expect(screen.getByTestId("shared-with-you-card")).toHaveAttribute("data-status", "error");
      expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
      await act(async () => { releaseExports([exportFor(TAX_REQUEST, "attr.financial.tax_record.*")]); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId("shared-with-you-values")).toHaveTextContent("Married filing jointly");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Run 4 (P1b): sensitive values stayed on screen about 4 minutes after Stop
// sharing in an already-shared card, which re-checked only on some event.
describe("access ending clears the values at once", () => {
  it("watches its bundle with the shared watch and clears on any reading of the stop", async () => {
    render(<SharedWithYouCard person={MANISH} items={[taxItem()]} />);
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("85000");
    expect(liveAccessWatchSnapshot().bundles).toEqual([BUNDLE]);
    // Another surface (the chat, the doorbell, the watch's own tick) reads the stop.
    mocks.getInformationRequest.mockResolvedValue(grantedBundle("revoked"));
    await act(async () => { await readInformationRequest({ bundleId: BUNDLE, vaultOwnerToken: "owner-token" }); });
    expect(screen.getByTestId("access-ended-notice")).toHaveTextContent("stopped sharing Tax record");
    expect(screen.queryByText("85000")).toBeNull();
    expect(mocks.getInformationRequestExports).toHaveBeenCalledTimes(1);
  });

  it("an already-shared item naming no bundle ends when its share leaves the list", async () => {
    mocks.listSharedWithMe.mockResolvedValue([{ bundleId: BUNDLE, requestId: TAX_REQUEST, person: "Manish Sainani",
      personRef: PERSON, profilePath: null, label: "Tax record", purpose: null, expiresAt: null }]);
    render(<SharedWithYouCard person={MANISH} items={[taxItem({ bundleId: null, requestId: null })]} />);
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("85000");
    expect(liveAccessWatchSnapshot()).toEqual({ bundles: [BUNDLE], shares: true });
    // Control: the share still listed keeps the values.
    await act(async () => { await readSharedWithMe({ vaultOwnerToken: "owner-token" }); });
    expect(screen.getByText("85000")).toBeInTheDocument();
    mocks.listSharedWithMe.mockResolvedValue([]);
    await act(async () => { await readSharedWithMe({ vaultOwnerToken: "owner-token" }); });
    expect(screen.getByTestId("access-ended-notice")).toBeInTheDocument();
    expect(screen.queryByText("85000")).toBeNull();
  });
});

// Run 4 (S3): "Work preferences" twice, and Profile and the person page
// listing the same items in different orders.
describe("one row per item, in one order everywhere", () => {
  it("collapses copies of the same request or grant and sorts by label, then when shared", () => {
    const work = (key: string, overrides: Partial<SharedWithMeCardItem> = {}) =>
      taxItem({ key, grantRef: "request_work_1", requestId: "request_work_1", label: "Work preferences", ...overrides });
    const entity = taxItem({ key: "entity", grantRef: "request_entity", requestId: "request_entity", label: "Entity" });
    const legal = taxItem({ key: "legal", grantRef: "request_legal", requestId: "request_legal", label: "legal entity information" });
    const older = taxItem({ key: "tax-old", grantRef: "request_tax_old", requestId: "request_tax_old", sharedAt: "2026-09-01T00:00:00Z" });
    const profileOrder = normalizeSharedItems([legal, work("w1", { bundleId: null }), entity, work("w2"), older, taxItem()]);
    const personPageOrder = normalizeSharedItems([taxItem(), work("w2"), older, entity, work("w1", { bundleId: null }), legal]);
    expect(profileOrder).toEqual(personPageOrder);
    expect(profileOrder.map((item) => item.key)).toEqual(["entity", "legal", "tax-old", TAX_REQUEST, "w2"]);
    // The copy that can be opened wins over one that names no bundle.
    expect(profileOrder.find((item) => item.label === "Work preferences")?.bundleId).toBe(BUNDLE);
  });
});
