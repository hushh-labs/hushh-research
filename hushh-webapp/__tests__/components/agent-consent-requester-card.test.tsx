import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InformationRequestReviewExperience, ScopeDiscoveryExperience } from "@/lib/agent/agui-structured-experiences";
import type { ViewerPersonProfile } from "@/lib/services/person-profile-service";

const mocks = vi.hoisted(() => ({
  user: { uid: "requester-a", getIdToken: vi.fn(async () => "test-token") },
  unlocked: true, getViewer: vi.fn(), create: vi.fn(), getInformationRequest: vi.fn(),
  getInformationRequestExports: vi.fn(), readStoredConnector: vi.fn(), decryptScopedExport: vi.fn(),
  searchScopeCatalog: vi.fn(),
}));
vi.mock("@/lib/services/agent-chat-client", () => ({ getAgentChatConsentOutcomes: async () => ({}) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultKey: "test-key", vaultOwnerToken: "test-owner-token" }) }));
vi.mock("@/lib/services/person-profile-service", async importOriginal => ({
  ...await importOriginal<object>(),
  PersonProfileService: {
    getViewer: mocks.getViewer, createInformationRequest: mocks.create,
    getInformationRequest: mocks.getInformationRequest, getInformationRequestExports: mocks.getInformationRequestExports,
    searchScopeCatalog: mocks.searchScopeCatalog,
  },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {
  ensureConnector: async () => ({ connector_key_id: "test-connector" }),
  readStoredConnector: mocks.readStoredConnector,
  decryptScopedExport: mocks.decryptScopedExport,
} }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: { children: ReactNode; variant?: string; size?: string }) => <button {...props}>{children}</button> }));
vi.mock("@/lib/morphy-ux/ui/surface-primitives", () => ({
  SectionCard: ({ children, title }: { children: ReactNode; title: string }) => <section><h4>{title}</h4>{children}</section>,
  StatusPill: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/consent/consent-scope-nested-list", () => ({
  ConsentScopeNestedList: ({ items }: { items: Array<{ id: string; label: string }> }) =>
    <div>{items.map(item => <span key={item.id}>{item.label}</span>)}</div>,
}));

import { AgentStructuredExperienceView, AgentTranscriptRevealContext } from "@/components/agent/agent-structured-experience";
import { ConsentCardPhaseContext, RequesterProgressBody } from "@/components/agent/consent/requester-consent-card";
import { AccessEndedNotice } from "@/components/agent/consent/access-ended-notice";
import { SharedDetailsList, humanSharedDetails, sharedItemRows } from "@/components/agent/consent/shared-details";
import { parseRequestProgress, progressHeadline, timelineFor, type RequestProgress } from "@/components/agent/consent/request-progress";
import { askSentence } from "@/components/agent/consent/ask-proposal-card";
import { parseScopeProposal } from "@/lib/agent/scope-proposal";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";
import { DecryptedRecordContent } from "@/components/connections/decrypted-grant-card";
import { clearSentInformationRequests } from "@/lib/agent/consent-continuation";
import { readInformationRequest } from "@/lib/consent/information-request-reads";
import { AgentTurnStreamPanel } from "@/components/agent/agent-turn-stream-panel";
import { AppStreamPanel } from "@/components/app-ui/stream-progress-panel";
import { SelectionChip } from "@/components/agent/selection-chip";
import { Check, MinusCircle, ShieldOff } from "@/components/icons";
import { CONSENT_OUTCOME_LABELS, wireOutcomeForSentLabel } from "@/lib/consent/open-granted-person-information";

const ASKED = "2026-09-28T13:49:00Z";
// Keep active-access fixtures safely in the future so this test does not expire with wall time.
const ENDS = "2099-10-05T12:00:00Z";

function progress(overrides: Partial<Record<string, unknown>> = {}): RequestProgress {
  const parsed = parseRequestProgress({
    requested_at: ASKED, delivered_at: null, seen_at: null, decided_at: null,
    outcome: "pending", access_ends_at: null, ended_at: null,
    fields: [{ scope: "attr.food.preferences.*", label: "Food preferences", status: "pending" }],
    ...overrides,
  });
  if (!parsed) throw new Error("fixture progress did not parse");
  return parsed;
}

function stateOf(steps: ReturnType<typeof timelineFor>) {
  return Object.fromEntries(steps.map(step => [step.key, `${step.state}:${step.label}`]));
}

/** Memory tree exactly as the baseline screenshot rendered it raw. */
const MEMORY_TREE = {
  preferences: { entities: {
    food_preferences: {
      kind: "preference", status: "active",
      summary: "My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings.",
      observations: ["My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings."],
    },
    mem_65725402299c: {
      kind: "preference", status: "active", summary: "Favorite restaurant is Nopa in San Francisco.",
      created_at: "2026-09-20T10:00:00Z", entity_id: "0f8c2a1e-5b6d-4c3e-9a7b-1d2e3f4a5b6c",
    },
  } },
};

function assertNoInternalIds(root: HTMLElement) {
  const text = root.textContent ?? "";
  for (const pattern of [/mem[\s_-]?65725402299c/i, /\bkind\b/i, /\bstatus\b/i, /\bentities\b/i, /0f8c2a1e/i, /2026-09-20/]) {
    if (pattern.test(text)) throw new Error(`internal detail rendered: ${pattern}`);
  }
}

describe("request progress timeline", () => {
  it("rejects missing or malformed progress so older backends keep today's card", () => {
    expect(parseRequestProgress(undefined)).toBeNull();
    expect(parseRequestProgress({ outcome: "granted" })).toBeNull();
    expect(parseRequestProgress({ requested_at: ASKED, outcome: "maybe" })).toBeNull();
  });

  it("tolerates a withdrawn request: parses cancelled and shows only what really happened", () => {
    const withdrawn = progress({ outcome: "cancelled", delivered_at: ASKED,
      fields: [{ label: "Food preferences", status: "cancelled" }] });
    expect(withdrawn.outcome).toBe("cancelled");
    expect(withdrawn.fields).toEqual([{ label: "Food preferences", status: "cancelled" }]);
    const steps = timelineFor(withdrawn);
    expect(stateOf(steps)).toMatchObject({ delivered: "done:Delivered", seen: "upcoming:Seen", decided: "done:Withdrawn" });
    expect(steps.some(step => step.state === "current")).toBe(false);
    expect(steps.map(step => step.key)).not.toContain("reading");
    expect(progressHeadline(withdrawn, "Kushal Trivedi")).toBe("You withdrew this request");
  });

  it("walks Asked, Delivered, Seen, Decided with exactly one live step while waiting", () => {
    expect(stateOf(timelineFor(progress()))).toMatchObject({ asked: "done:Asked", delivered: "current:Delivered", seen: "upcoming:Seen" });
    expect(stateOf(timelineFor(progress({ delivered_at: ASKED })))).toMatchObject({ delivered: "done:Delivered", seen: "current:Seen" });
    expect(stateOf(timelineFor(progress({ delivered_at: ASKED, seen_at: ASKED })))).toMatchObject({ seen: "done:Seen", decided: "current:Decided" });
    for (const p of [progress(), progress({ delivered_at: ASKED }), progress({ delivered_at: ASKED, seen_at: ASKED })]) {
      expect(timelineFor(p).filter(step => step.state === "current")).toHaveLength(1);
    }
  });

  it("marks a decision done and only pulses Reading when the chat says so", () => {
    const granted = progress({ decided_at: ASKED, outcome: "granted", access_ends_at: ENDS,
      fields: [{ label: "Food preferences", status: "granted" }] });
    const idle = stateOf(timelineFor(granted));
    expect(idle).toMatchObject({ delivered: "done:Delivered", seen: "done:Seen", decided: "done:Shared", reading: "upcoming:Reading" });
    expect(timelineFor(granted).some(step => step.state === "current")).toBe(false);
    expect(stateOf(timelineFor(granted, "reading"))).toMatchObject({ reading: "current:Reading", answered: "upcoming:Answered" });
    expect(timelineFor(granted, "answered").every(step => step.state === "done")).toBe(true);
  });

  it("skips Reading for a decline and for an unanswered expiry", () => {
    const denied = timelineFor(progress({ decided_at: ASKED, outcome: "denied", fields: [{ label: "Food preferences", status: "denied" }] }));
    expect(denied.map(step => step.key)).toEqual(["asked", "delivered", "seen", "decided", "answered"]);
    expect(denied.find(step => step.key === "decided")).toMatchObject({ label: "Declined", tone: "neutral" });
    const lapsed = stateOf(timelineFor(progress({ outcome: "expired", delivered_at: ASKED })));
    expect(lapsed).toMatchObject({ seen: "upcoming:Seen", decided: "done:No answer" });
  });
});

describe("living requester card body", () => {
  afterEach(cleanup);

  it("pulses the current step only through motion-safe, so reduced motion stays still", () => {
    render(<RequesterProgressBody progress={progress({ delivered_at: ASKED })} personName="Kushal Trivedi" purpose="Dinner" />);
    const pulse = screen.getByTestId("timeline-pulse");
    expect(pulse.className).toContain("motion-safe:animate-pulse");
    expect(pulse.className.split(/\s+/)).not.toContain("animate-pulse");
    expect(screen.getByRole("list", { name: "Request progress" }).querySelector("[aria-current='step']"))
      .toHaveAttribute("data-step", "seen");
    expect(screen.getByRole("status")).toHaveTextContent("Delivered to Kushal");
  });

  it("says when the person saw it, not that it was delivered, once Seen is done", () => {
    const SEEN = "2026-09-28T14:05:00Z";
    render(<RequesterProgressBody progress={progress({ delivered_at: ASKED, seen_at: SEEN })} personName="Kushal Trivedi" purpose="Dinner" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^Kushal saw it\s*\d{1,2}:\d{2}\s?[AP]M$/);
    expect(status).not.toHaveTextContent("Delivered");
  });

  it("lists shared and declined items with human labels and when access ends", () => {
    const partial = progress({ decided_at: ASKED, outcome: "partially_granted", access_ends_at: ENDS, fields: [
      { label: "Food preferences", status: "granted" }, { label: "Health notes", status: "denied" },
    ] });
    render(<RequesterProgressBody progress={partial} personName="Kushal Trivedi" purpose="Dinner"
      details={<button type="button">View shared information</button>} />);
    expect(screen.getByRole("status")).toHaveTextContent("Kushal shared some of what you asked");
    const body = screen.getByTestId("requester-progress");
    expect(body).toHaveTextContent("Shared Food preferences");
    expect(body).toHaveTextContent("Not shared Health notes");
    expect(within(screen.getByRole("list", { name: "Request progress" })).getByText("Shared")).toBeInTheDocument();
    expect(screen.getByText("Access ends Oct 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View shared information" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/scope|grant|attr\./i);
  });

  it("replaces the shared details with Access ended after a revoke", () => {
    const revoked = progress({ decided_at: ASKED, outcome: "revoked", ended_at: "2026-09-29T12:00:00Z",
      fields: [{ label: "Food preferences", status: "revoked" }] });
    render(<RequesterProgressBody progress={revoked} personName="Kushal Trivedi" purpose="Dinner"
      details={<div data-testid="chat-shared-information">Nopa</div>} />);
    expect(screen.getByTestId("access-ended-notice"))
      .toHaveTextContent("Kushal stopped sharing Food preferences. One no longer uses it.");
    expect(screen.queryByTestId("chat-shared-information")).toBeNull();
    expect(document.body.textContent).not.toContain("Nopa");
  });

  // Localhost run 2026-09-28 (screenshot 17): "Kushal stopped sharing Food
  // preferences" still carried the success check.
  it("marks a stopped or declined chip with a neutral icon, never the check", () => {
    const svg = (node: ReactNode) => render(<>{node}</>).container.querySelector("svg")!.innerHTML;
    const checkMark = svg(<Check />);
    const endedMark = svg(<ShieldOff />);
    cleanup();
    render(<SelectionChip label="Kushal stopped sharing Food preferences" ended />);
    const chip = screen.getByTestId("selection-chip");
    expect(chip).toHaveAttribute("data-state", "ended");
    expect(chip.querySelector("svg")!.innerHTML).toBe(endedMark);
    cleanup();
    // Localhost run 4 (R6): "Kushal declined" carried the check too.
    const declinedMark = svg(<MinusCircle />);
    cleanup();
    render(<SelectionChip label="Kushal declined" outcome="denied" />);
    expect(screen.getByTestId("selection-chip")).toHaveAttribute("data-state", "declined");
    expect(screen.getByTestId("selection-chip").querySelector("svg")!.innerHTML).toBe(declinedMark);
    cleanup();
    // Negative control: a shared chip keeps its check.
    render(<SelectionChip label="Kushal shared Food preferences" outcome="granted" />);
    expect(screen.getByTestId("selection-chip").querySelector("svg")!.innerHTML).toBe(checkMark);
    expect(new Set([checkMark, endedMark, declinedMark]).size).toBe(3);
    // The chat hands every chip its outcome; without it a decline falls back
    // to the check. A chip no card claimed reads its outcome from the label.
    const workspace = readFileSync(path.join(process.cwd(), "components/agent/agent-chat-workspace.tsx"), "utf8");
    expect(workspace).toContain("outcome={consentChipOutcome(message)}");
    expect(wireOutcomeForSentLabel(CONSENT_OUTCOME_LABELS.denied)).toBe("denied");
  });

  it("words an expiry after sharing as ended on a day", () => {
    render(<AccessEndedNotice personName="Kushal Trivedi" labels={["Food preferences"]} reason="expired" endedAt={ENDS} />);
    expect(screen.getByTestId("access-ended-notice"))
      .toHaveTextContent("Access to Food preferences from Kushal ended Oct 5. One no longer uses it.");
  });
});

describe("human-readable shared details", () => {
  afterEach(cleanup);

  it("renders label and value rows, never ids, kinds or statuses", () => {
    const rows = humanSharedDetails(MEMORY_TREE, "Food preferences");
    expect(rows).toEqual([
      { label: "Food preferences", values: ["My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings."] },
      { label: "Preferences", values: ["Favorite restaurant is Nopa in San Francisco."] },
    ]);
    const view = render(<SharedDetailsList values={[{ requestId: "r1", label: "Food preferences", data: MEMORY_TREE }]} />);
    expect(screen.getByTestId("chat-shared-information")).toHaveTextContent("Neapolitan pizza");
    expect(() => assertNoInternalIds(view.container)).not.toThrow();
  });

  // Regression (localhost run 2026-09-28): one shared item read as two rows,
  // "Food preferences" and "Preferences", from the memory tree's own keys.
  it("heads each shared item with the server's label only, never a key from the tree", () => {
    const rows = sharedItemRows([{ requestId: "r1", label: "Food preferences", data: MEMORY_TREE }]);
    expect(rows).toEqual([{ key: "r1", label: "Food preferences", values: [
      "My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings.",
      "Favorite restaurant is Nopa in San Francisco.",
    ] }]);
    render(<SharedDetailsList values={[{ requestId: "r1", label: "Food preferences", data: MEMORY_TREE }]} />);
    const headings = [...screen.getByTestId("chat-shared-information").querySelectorAll("dt")].map((node) => node.textContent);
    expect(headings).toEqual(["Food preferences"]);
  });

  it("negative control: the same check fails on the raw tree renderer", () => {
    const raw = render(<DecryptedRecordContent data={MEMORY_TREE} />);
    expect(() => assertNoInternalIds(raw.container)).toThrow(/internal detail rendered/);
  });

  // Regression (localhost run 2026-09-28, screenshot 09): the decrypted export
  // is the owner's envelope, `{ [domain]: record, __export_metadata }`. Its
  // bookkeeping rendered as values under "Food preferences": "food", "2",
  // "preferences.entities._entities.kind", "..._items", and "Show all 9".
  it("shows only readable lines from a real export envelope, never its bookkeeping", () => {
    const EXPORT_ENVELOPE = {
      food: { preferences: { entities: { _entities: [{
        kind: "preference",
        observations: { _items: [
          "My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings.",
          "My favorite restaurant is Nopa in San Francisco.",
        ] },
        observation_count: 2,
      }] } } },
      __export_metadata: {
        scope: "attr.food.preferences.*",
        source_domain: "food",
        manifest_version: 2,
        approved_paths: ["preferences.entities._entities.kind", "preferences.entities._entities.observations._items"],
        approved_segment_ids: ["preferences"],
        export_timestamp: "2026-09-29T00:21:40.000Z",
      },
    };
    expect(sharedItemRows([{ requestId: "r1", label: "Food preferences", data: EXPORT_ENVELOPE }])).toEqual([{
      key: "r1", label: "Food preferences", values: [
        "My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings.",
        "My favorite restaurant is Nopa in San Francisco.",
      ],
    }]);
    render(<SharedDetailsList values={[{ requestId: "r1", label: "Food preferences", data: EXPORT_ENVELOPE }]} />);
    const text = screen.getByTestId("chat-shared-information").textContent ?? "";
    expect(text).not.toMatch(/_entities|_items|\.entities\.|\bfood\b|\b2\b|Show all/);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("reads a short field as a labelled line and drops counts and bare numbers", () => {
    const rows = sharedItemRows([{ requestId: "r1", label: "Food preferences", data: {
      favorite_cuisine: "Neapolitan pizza", spice_level: 3, item_count: 4, vegetarian: true, _items: [7],
    } }]);
    expect(rows).toEqual([{ key: "r1", label: "Food preferences", values: [
      "Favorite cuisine: Neapolitan pizza", "Spice level: 3", "Vegetarian: Yes",
    ] }]);
  });

  // Localhost run 4 (S3): a legal entity read "Fein", "Naics code" and "C_CORP".
  it("names known fields as people write them and reads a stored enum as words", () => {
    const rows = sharedItemRows([{ requestId: "r1", label: "Legal entity", data: {
      fein: "12-3456789", naics_code: "541511", trade_name_dba: "Acme Labs", street_1: "1 Main St",
      entity_type: "C_CORP", filing_status: "MARRIED_FILING_JOINTLY", handle: "kushal_t",
    } }]);
    expect(rows[0]!.values).toEqual([
      "Federal EIN: 12-3456789", "NAICS code: 541511", "Trade name (DBA): Acme Labs", "Street address: 1 Main St",
      "Entity type: C corporation", "Filing status: Married filing jointly",
      // Negative control: the person's own value is never rewritten.
      "Handle: kushal_t",
    ]);
  });

  it("collapses long values behind Show more", () => {
    const long = "Vegetarian ".repeat(30).trim();
    render(<SharedDetailsList values={[{ requestId: "r1", label: "Diet", data: { diet: long } }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });
});

const person = "1234567890abcdef";
const bundleId = "bundle_12345678";
const requestId = "request_12345678";
const restored: InformationRequestReviewExperience = {
  type: "one.information_request_review.v1", personName: "Kushal Trivedi",
  purpose: "Picking a place for our dinner together", durationLabel: "7 days",
  direction: "outgoing", phase: "submitted", subjectRef: person, bundleId, requestId: null, status: "pending",
  fields: [{ label: "Preferences", domain: "Lifestyle", sensitivity: "standard", requestId }],
};
function bundle(status: "pending" | "granted" | "revoked", withProgress: boolean) {
  return {
    personRef: person, bundleId, purpose: restored.purpose, durationSeconds: 168 * 3600, cancelled: false,
    items: [{ requestId, scopeRef: "scope-food", label: "Preferences", sensitivity: "standard", status }],
    ...(withProgress ? { progress: {
      requested_at: ASKED, delivered_at: ASKED, seen_at: status === "pending" ? null : ASKED,
      decided_at: status === "pending" ? null : ASKED,
      outcome: status, access_ends_at: status === "granted" ? ENDS : null,
      ended_at: status === "revoked" ? "2026-09-29T12:00:00Z" : null,
      fields: [{ scope: "attr.food.preferences.*", label: "Food preferences", status }],
    } } : {}),
  };
}

describe("InformationRequestReviewView with and without progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSentInformationRequests();
    mocks.unlocked = true;
  });
  afterEach(cleanup);

  // Localhost run 2026-09-28 (screenshot 02): "I'll ask Kushal Trivedi. Here's
  // what I'd request:" rendered below the card it introduces.
  it("reads One's lead-in before the ask card it introduces", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("pending", false));
    const lead = "I'll ask Kushal Trivedi. Here's what I'd request:";
    render(<AgentTurnStreamPanel streamEvents={[]} responseText={lead} response={<p>{lead}</p>}
      isStreaming={false} structuredExperiences={[{ id: "card", experience: restored }]} />);
    const card = await screen.findByText("Waiting for Kushal Trivedi's approval");
    const text = screen.getByText(lead);
    expect(text.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("negative control: any other card keeps its place above the answer it precedes", () => {
    render(<AppStreamPanel responseText="Here is the summary." structuredContent={<div>Evidence card</div>} />);
    const card = screen.getByText("Evidence card");
    const text = screen.getByText("Here is the summary.");
    expect(card.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("falls back to today's card when the server sends no progress", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("pending", false));
    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByText("Waiting for Kushal Trivedi's approval")).toBeInTheDocument();
    expect(screen.queryByTestId("request-timeline")).toBeNull();
  });

  it("renders the living card from progress and takes the phase from the chat", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("granted", true));
    render(<ConsentCardPhaseContext.Provider value={(id) => id === bundleId ? "reading" : null}>
      <AgentStructuredExperienceView experience={restored} />
    </ConsentCardPhaseContext.Provider>);
    const card = await screen.findByTestId("requester-progress");
    expect(card).toHaveAttribute("data-phase", "reading");
    expect(within(card).getByRole("status")).toHaveTextContent("Reading what Kushal shared…");
    expect(screen.getByText("Food preferences from Kushal Trivedi")).toBeInTheDocument();
    expect(screen.getByText("Access ends Oct 5")).toBeInTheDocument();
    expect(card.querySelector("[aria-current='step']")).toHaveAttribute("data-step", "reading");
  });

  // A5 (localhost run 4): asked again while the request waited, One offered a
  // fresh ask card with Send. The server now reports it as already waiting;
  // this is its exact output (test_consent_lifecycle_chat.py, TestPropose).
  it("renders an already waiting request as its living card, with no Send", async () => {
    const PERSON_REF = "11111111-1111-4111-8111-111111111111";
    const BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const alreadyPending = {
      status: "already_pending",
      person: { displayName: "Sarah Chen", personRef: PERSON_REF, profilePath: `/people/${PERSON_REF}` },
      bundleId: BUNDLE,
      fields: ["Favorite cuisine"],
      purpose: "To pick a restaurant for dinner",
      sentAt: "2026-09-29T06:30:00+00:00",
      livingCard: {
        personName: "Sarah Chen", purpose: "To pick a restaurant for dinner", durationLabel: "7 days",
        status: "pending", direction: "outgoing", phase: "submitted", subjectRef: PERSON_REF, bundleId: BUNDLE,
        fields: [{ label: "Favorite cuisine", domain: "Information" }],
      },
      nextStep: "Say in one short line that your request to Sarah Chen for Favorite cuisine is already waiting on them, and that the request card shows where it stands. Do not ask them to tap Send, do not offer to send it again, and do not call another consent action.",
    };
    const experience = parseAgentToolResultExperience("propose_information_request", alreadyPending);
    expect(experience).toMatchObject({
      type: "one.information_request_review.v1", direction: "outgoing", phase: "submitted",
      subjectRef: PERSON_REF, bundleId: BUNDLE, status: "pending",
    });
    mocks.getInformationRequest.mockResolvedValue({ ...bundle("pending", true), personRef: PERSON_REF, bundleId: BUNDLE });
    render(<AgentStructuredExperienceView experience={experience!} />);
    const card = await screen.findByTestId("requester-progress");
    expect(card).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    // Negative control: without its descriptor nothing renders, never an ask card.
    expect(parseAgentToolResultExperience("propose_information_request",
      { ...alreadyPending, livingCard: undefined })).toBeNull();
  });

  // Run 4 (R1): the chat knew "Reading…" at 19.1s, but the card waited on its
  // own read of a starved pool and still said "Seen" until 33.5s.
  it("shows Reading… from the doorbell's reading at once, even while its own reads stall", async () => {
    mocks.getInformationRequest.mockResolvedValueOnce(bundle("pending", true));
    let phase: "reading" | null = null;
    const card = () => (
      <ConsentCardPhaseContext.Provider value={(id) => id === bundleId ? phase : null}>
        <AgentStructuredExperienceView experience={restored} />
      </ConsentCardPhaseContext.Provider>
    );
    const view = render(card());
    expect(await screen.findByTestId("requester-progress")).toHaveAttribute("data-outcome", "pending");
    // The doorbell reads the approval; every read after it stalls.
    mocks.getInformationRequest.mockResolvedValueOnce(bundle("granted", true));
    mocks.getInformationRequest.mockReturnValue(new Promise(() => undefined));
    await act(async () => { await readInformationRequest({ bundleId, vaultOwnerToken: "test-owner-token" }); });
    phase = "reading";
    view.rerender(card());
    const progress = screen.getByTestId("requester-progress");
    expect(progress).toHaveAttribute("data-outcome", "granted");
    expect(within(progress).getByRole("status")).toHaveTextContent("Reading what Kushal shared…");
  });

  it("drops revealed values and shows Access ended when the owner revokes", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("granted", true));
    mocks.getInformationRequestExports.mockResolvedValue([{
      requestId, scopeRef: "scope-food",
      encryptedExport: {
        request_id: requestId, scope: "attr.food.preferences.*", export_revision: 1,
        export_envelope: { version: 2, export_id: "export-1", aad: {
          version: 2, app_id: "agent_one", grant_id: requestId, export_id: "export-1",
          revision: 1, machine_scope: "attr.food.preferences.*", scope_handle: "scope-handle",
          recipient_key_fingerprint: "fingerprint", payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3600_000,
        } },
      },
    }]);
    mocks.readStoredConnector.mockResolvedValue({ connector_key_id: "test-connector" });
    mocks.decryptScopedExport.mockResolvedValue(MEMORY_TREE);
    render(<AgentStructuredExperienceView experience={restored} />);
    // The approval shows the secure card at once: no reveal control to find.
    const details = await screen.findByTestId("shared-with-you-values");
    expect(details).toHaveTextContent("Nopa");
    expect(screen.queryByRole("button", { name: "View shared information" })).toBeNull();
    expect(() => assertNoInternalIds(details)).not.toThrow();

    mocks.getInformationRequest.mockResolvedValue(bundle("revoked", true));
    act(() => window.dispatchEvent(new Event("consent-state-changed")));
    expect(await screen.findByTestId("access-ended-notice"))
      .toHaveTextContent("Kushal stopped sharing Food preferences. One no longer uses it.");
    expect(screen.queryByTestId("shared-with-you-values")).toBeNull();
    expect(document.body.textContent).not.toContain("Nopa");
  });
});

describe("the living card during a refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSentInformationRequests();
    mocks.unlocked = true;
  });
  afterEach(cleanup);

  // Regression (localhost run 2026-09-28): a refresh blanked the card to the
  // pre-progress "Request sent · 1 thing" card before it read "Access ended".
  it("keeps its last reading while it refetches, then turns to Access ended", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("granted", true));
    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByText("Food preferences from Kushal Trivedi")).toBeInTheDocument();

    let settle: (value: unknown) => void = () => undefined;
    mocks.getInformationRequest.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: {
      source: "information_request_updated", bundleId: bundleId.toUpperCase(), requestId, action: "CONSENT_REVOKED",
    } })));
    // Mid-refetch: the same living card, never the fallback card or a blank.
    expect(screen.getByTestId("requester-progress")).toBeInTheDocument();
    expect(screen.getByText("Food preferences from Kushal Trivedi")).toBeInTheDocument();
    expect(screen.queryByText(/1 thing/)).toBeNull();
    expect(screen.queryByText("Checking current status…")).toBeNull();

    await act(async () => { settle(bundle("revoked", true)); });
    expect(await screen.findByTestId("access-ended-notice")).toBeInTheDocument();
    expect(screen.queryByText(/1 thing/)).toBeNull();
  });
});

function viewer(): ViewerPersonProfile {
  return { personRef: person, displayName: "Kushal Trivedi", photoUrl: null, verifiedRole: null,
    relationship: { status: "connected", connectionId: "c", connectedAt: null, requestId: null },
    grants: [], requestHistory: [], requestableScopes: [
      { scopeRef: "scope-food", label: "Food preferences", description: null, domain: "lifestyle", sensitivity: "standard", wildcard: false },
    ],
  };
}
const discovery: ScopeDiscoveryExperience = {
  type: "one.scope_discovery.v1",
  person: { personRef: person, displayName: "Kushal Trivedi", profilePath: `/people/${person}`, relationship: "connected" },
  domainFilter: null, scopes: [],
};
const proposal = { proposed: [{ scopeRef: "scope-food", label: "Food preferences", why: "You asked where to eat." }],
  durationHours: 168, reasonSuggestion: "dinner planning" };

describe("One picks, you confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unlocked = true;
    mocks.getViewer.mockResolvedValue(viewer());
    mocks.create.mockResolvedValue({ personRef: person, bundleId, purpose: "dinner planning", durationSeconds: 168 * 3600,
      cancelled: false, items: [{ requestId, scopeRef: "scope-food", label: "Food preferences", sensitivity: "standard", status: "pending" }] });
    mocks.getInformationRequest.mockResolvedValue(bundle("pending", true));
    mocks.searchScopeCatalog.mockResolvedValue({ scopes: [
      { scopeRef: "scope-restaurants", label: "Favorite restaurants", description: null, domain: "lifestyle", sensitivity: null, wildcard: false },
    ], page: 1, hasMore: false, nextPage: null, totalCount: 1 });
  });
  afterEach(cleanup);

  it("parses the server proposal and phrases it as one sentence", () => {
    const parsed = parseScopeProposal({ person: "kushal", proposed: [{ scope: "scope-food", label: "Food preferences", why: "x" }],
      duration_default: "7d", reason_suggestion: "dinner planning" });
    expect(parsed).toEqual({ proposed: [{ scopeRef: "scope-food", label: "Food preferences", why: "x" }], durationHours: 168, reasonSuggestion: "dinner planning" });
    expect(askSentence("Kushal Trivedi", ["Food preferences"], 168))
      .toBe("Ask Kushal for Food preferences · 7 days");
    expect(parseScopeProposal({ proposed: [] })).toBeNull();
    const experience = parseAgentToolResultExperience("propose_information_request", {
      status: "ok", person: discovery.person, requestableScopes: [],
      proposed: [{ scope: "scope-food", label: "Food preferences", why: null }], duration_default: 168, reason_suggestion: "dinner planning",
    });
    expect(experience).toMatchObject({ type: "one.scope_discovery.v1", proposal: { durationHours: 168 } });
  });

  it("reads Lane B's actual propose_information_request output (test_consent_lifecycle_chat.py)", () => {
    // The exact shape consent-protocol asserts for "What is Sarah Chen's favorite restaurant?".
    const PERSON_REF = "11111111-1111-4111-8111-111111111111";
    const laneB = {
      status: "proposal_ready", proposalId: "a".repeat(32),
      person: { displayName: "Sarah Chen", personRef: PERSON_REF, profilePath: `/people/${PERSON_REF}` },
      fields: ["Favorite cuisine"], unmatchedFields: [],
      purpose: "I'd like to know your favorite cuisine.", durationHours: 168,
      proposed: [{ scope: "psr_cuisine", label: "Favorite cuisine", why: "\"restaurant\" relates to food & dining" }],
      alternatives: [{ scope: "psr_diet", label: "Dietary needs", why: "Related" }],
      duration_default: "7d", reason_suggestion: "I'd like to know your favorite cuisine.",
      connectorReady: true, nextStep: "Say one short line.",
      directive: { actionId: "consent.request", slots: { scopeRefs: ["psr_cuisine"] } },
    };
    const experience = parseAgentToolResultExperience("propose_information_request", laneB);
    expect(experience).toMatchObject({
      type: "one.scope_discovery.v1",
      person: { personRef: PERSON_REF, displayName: "Sarah Chen", profilePath: `/people/${PERSON_REF}` },
      proposal: {
        proposed: [{ scopeRef: "psr_cuisine", label: "Favorite cuisine", why: "\"restaurant\" relates to food & dining" }],
        durationHours: 168,
        reasonSuggestion: "I'd like to know your favorite cuisine.",
      },
    });
    // A non-day duration travels as B's numeric durationHours, which wins over its label.
    const oneDay = parseAgentToolResultExperience("propose_information_request",
      { ...laneB, durationHours: 24, duration_default: "24 hours" });
    expect(oneDay).toMatchObject({ proposal: { durationHours: 24 } });
    // A person reference that does not match its profile path is refused, never trusted.
    expect(parseAgentToolResultExperience("propose_information_request",
      { ...laneB, person: { ...laneB.person, personRef: "22222222-2222-4222-8222-222222222222" } }))
      .not.toMatchObject({ type: "one.scope_discovery.v1" });
  });

  it("sends One's pick through the existing send path", async () => {
    const onSubmitted = vi.fn(async () => undefined);
    render(<AgentStructuredExperienceView experience={{ ...discovery, proposal }} onInformationRequestSubmitted={onSubmitted} />);
    expect(screen.getByTestId("ask-sentence")).toHaveTextContent("Ask Kushal for Food preferences · 7 days");
    // The server's reason is its own line, as given; never glued on with "for".
    expect(screen.getByTestId("ask-reason")).toHaveTextContent("dinner planning");
    expect(screen.getByTestId("ask-sentence")).not.toHaveTextContent("for dinner planning");
    const send = await screen.findByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      personRef: person, scopeRefs: ["scope-food"], purpose: "dinner planning", durationSeconds: 168 * 3600,
    })));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ bundleId, subjectRef: person,
      review: expect.objectContaining({ phase: "submitted", bundleId, subjectRef: person, durationLabel: "7 days" }) })));
    expect(await screen.findByTestId("request-timeline")).toBeInTheDocument();
  });

  it("lifts its Send row above the composer once, when it appears", async () => {
    const reveal = vi.fn();
    const { rerender } = render(<AgentTranscriptRevealContext.Provider value={reveal}>
      <AgentStructuredExperienceView experience={{ ...discovery, proposal }} />
    </AgentTranscriptRevealContext.Provider>);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.calls[0][0]).toBe(screen.getByTestId("ask-proposal-actions"));
    expect(within(reveal.mock.calls[0][0] as HTMLElement).getByRole("button", { name: /Send|Checking/ })).toBeInTheDocument();
    rerender(<AgentTranscriptRevealContext.Provider value={reveal}>
      <AgentStructuredExperienceView experience={{ ...discovery, proposal }} />
    </AgentTranscriptRevealContext.Provider>);
    await screen.findByRole("button", { name: "Send" });
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("opens a server-searched picker behind Change and updates the sentence", async () => {
    render(<AgentStructuredExperienceView experience={{ ...discovery, proposal }} />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(mocks.searchScopeCatalog).toHaveBeenCalledWith(expect.objectContaining({ personRef: person, query: "", page: 1 })));
    fireEvent.change(screen.getByLabelText("Search what Kushal can share"), { target: { value: "restaurant" } });
    await waitFor(() => expect(mocks.searchScopeCatalog).toHaveBeenCalledWith(expect.objectContaining({ query: "restaurant", page: 1 })));
    fireEvent.click(await screen.findByRole("button", { name: "Favorite restaurants" }));
    expect(screen.getByTestId("ask-sentence")).toHaveTextContent("Ask Kushal for Food preferences and Favorite restaurants · 7 days");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("makes every proposed item a row: a group opens, is tri-state, and Send carries exactly the choice", async () => {
    // "lets request consent for legal entity": One proposed the domain and one of its fields.
    const legal = [
      { scopeRef: "scope-legal", label: "Legal Entity Domain", description: null, domain: "legal_entity", sensitivity: "standard",
        wildcard: true, pathSegments: [] },
      { scopeRef: "scope-entity", label: "Entity", description: null, domain: "legal_entity", sensitivity: "standard",
        wildcard: false, pathSegments: ["entity"] },
      { scopeRef: "scope-ein", label: "Employer id", description: null, domain: "legal_entity", sensitivity: "sensitive",
        wildcard: false, pathSegments: ["ein"] },
    ];
    mocks.getViewer.mockResolvedValue({ ...viewer(), requestableScopes: legal });
    mocks.create.mockResolvedValue({ personRef: person, bundleId, purpose: "Setting up the company account", durationSeconds: 168 * 3600,
      cancelled: false, items: [
        { requestId, scopeRef: "scope-entity", label: "Entity", sensitivity: "standard", status: "pending" },
      ] });
    const legalProposal = { proposed: [
      { scopeRef: "scope-legal", label: "Legal Entity Domain", why: "Matches what you asked for" },
      { scopeRef: "scope-entity", label: "Entity", why: null },
    ], durationHours: 168, reasonSuggestion: "Setting up the company account" };
    render(<AgentStructuredExperienceView experience={{ ...discovery, proposal: legalProposal }} />);

    const group = await screen.findByRole("checkbox", { name: /Legal entity/ });
    expect(screen.queryByText(/Domain/)).toBeNull();
    expect(group).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("ask-proposal-summary")).toHaveTextContent("2 items · 7 days");

    // Enter opens the group without changing the choice; Space toggles a row.
    fireEvent.keyDown(group, { key: "Enter" });
    expect(group).toHaveAttribute("aria-expanded", "true");
    const ein = screen.getByRole("checkbox", { name: "Employer id" });
    fireEvent.keyDown(ein, { key: " " });
    expect(ein).toHaveAttribute("aria-checked", "false");
    expect(group).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByTestId("ask-proposal-summary")).toHaveTextContent("1 item · 7 days");
    expect(screen.getByTestId("ask-sentence")).toHaveTextContent("Ask Kushal for Entity · 7 days");

    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    // The broad scope would still include what was taken out, so only the chosen child goes.
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ scopeRefs: ["scope-entity"] })));

    cleanup();
    render(<AgentStructuredExperienceView experience={{ ...discovery, proposal: legalProposal }} />);
    const whole = await screen.findByRole("checkbox", { name: /Legal entity/ });
    fireEvent.click(whole);
    expect(whole).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("ask-proposal-summary")).toHaveTextContent("0 items · 7 days");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(whole);
    expect(whole).toHaveAttribute("aria-checked", "true");
  });

  // Localhost run 4 (A2): "Request all of Kushal's food and dining
  // information" listed "Food & dining information" and "Food preferences"
  // flat. The broad item sorts past the viewer's first catalog page, so the
  // card never knew what it covered.
  it("nests a broad ask its first catalog page lacks, and Send carries the smallest set", async () => {
    const food = [
      { scopeRef: "scope-food-all", label: "Food & dining information", description: null, domain: "food", sensitivity: "standard",
        wildcard: true, pathSegments: [] },
      { scopeRef: "scope-food-prefs", label: "Food preferences", description: null, domain: "food", sensitivity: "standard",
        wildcard: true, pathSegments: ["preferences"] },
      { scopeRef: "scope-food-diet", label: "Dietary constraints", description: null, domain: "food", sensitivity: "standard",
        wildcard: false, pathSegments: ["dietary_constraints"] },
    ];
    mocks.getViewer.mockResolvedValue({ ...viewer(), requestableScopes: [
      { scopeRef: "scope-travel", label: "Trips", description: null, domain: "travel", sensitivity: "standard", wildcard: false, pathSegments: ["trips"] },
    ] });
    mocks.searchScopeCatalog.mockImplementation(async ({ query }: { query: string }) => ({
      scopes: query.startsWith("Food") ? food : [], page: 1, hasMore: false, nextPage: null, totalCount: 3,
    }));
    const broad = { proposed: [
      { scopeRef: "scope-food-all", label: "Food & dining information", why: "Matches what you asked for" },
      { scopeRef: "scope-food-prefs", label: "Food preferences", why: null },
    ], durationHours: 168, reasonSuggestion: "To view food and dining details" };
    render(<AgentStructuredExperienceView experience={{ ...discovery, proposal: broad }} />);

    // One group over what it covers, never the parent and child side by side.
    const group = await screen.findByRole("checkbox", { name: "Food & dining information" });
    await waitFor(() => expect(group).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getAllByTestId("ask-proposal-row")).toHaveLength(1);
    expect(group).toHaveAttribute("aria-checked", "true");
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Show what Food & dining information includes" }));
    const diet = screen.getByRole("checkbox", { name: "Dietary constraints" });
    fireEvent.click(diet);
    expect(group).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByTestId("ask-sentence")).toHaveTextContent("Ask Kushal for Food preferences · 7 days");
    fireEvent.click(diet);
    expect(group).toHaveAttribute("aria-checked", "true");

    fireEvent.click(send);
    // Fully chosen, the group goes as its one broad item.
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ scopeRefs: ["scope-food-all"] })));
  });

  it("falls back to the catalog when there is no proposal", async () => {
    render(<AgentStructuredExperienceView experience={discovery} />);
    expect(screen.queryByTestId("ask-proposal-card")).toBeNull();
    expect(await screen.findByRole("button", { name: "Review request" })).toBeInTheDocument();
  });
});
