import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const memory = vi.hoisted(() => ({ retrieve: vi.fn(), approve: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "owner" }, userId: "owner" }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true, vaultKey: "test-key", vaultOwnerToken: "test-token" }) }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdToken: async () => "test-id-token" } }));
vi.mock("@/lib/services/account-identity-service", () => ({ AccountIdentityService: { refreshIdentityForSession: async () => ({ user_id: "owner", display_name: "Owner", email: "owner@example.test", photo_url: null }) } }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 0, isVaultSessionEpochCurrent: () => true }));
vi.mock("@/lib/pkm/memory-scope-retrieval", () => ({ retrieveApprovedMemoryScopes: memory.retrieve }));
vi.mock("@/lib/services/answer-request-service", () => ({ AnswerRequestService: { approve: memory.approve, decline: vi.fn(), retryResolution: vi.fn() } }));
vi.mock("@/components/consent/answer-payout-account", () => ({
  AnswerPayoutAccount: () => null,
}));
const priceSheet = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/consent/document-request-price-sheet", () => ({
  DocumentRequestPriceSheet: (props: Record<string, unknown>) => {
    priceSheet.props = props;
    return props.open ? <>{props.settlement as React.ReactNode}</> : null;
  },
}));
import { AnswerRequestReview } from "@/components/consent/answer-request-review";
import type { PendingAnswerRequest } from "@/lib/services/answer-request-service";
afterEach(cleanup);
beforeEach(() => {
  memory.approve.mockReset().mockResolvedValue({ termsDigest: "digest" });
  memory.retrieve.mockReset().mockImplementation(async ({ approvedScopes }: { approvedScopes: string[] }) => ({
    projections: approvedScopes.map(scope => ({ scope, payload: { value: "recorded" }, contentRevision: 1 })),
    unavailableScopes: [], complete: true, assertCurrent: async () => undefined,
  }));
});
const base: PendingAnswerRequest = {
  requestId: "r",
  requesterUserId: "peer",
  question: "What meals do you prefer?",
  periodStart: null,
  periodEnd: null,
  resolutionMode: "skipped",
  resolutionSkippedReason: "resolver_failed",
  proposedScopes: [
    { scope: "attr.food.preferences", label: "Food preferences" },
  ],
};
it("failed resolution cannot expose the catalog or permit pricing", () => {
  render(<AnswerRequestReview request={base} requesterLabel="Peer" />);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByText("Food preferences")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry matching" })).toBeEnabled();
});
it("successful empty resolution never falls back to every scope", () => {
  render(
    <AnswerRequestReview
      request={{ ...base, resolutionMode: "agent", proposedScopes: [] }}
      requesterLabel="Peer"
    />,
  );
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  expect(
    screen.queryByRole("checkbox", { name: "Food preferences" }),
  ).not.toBeInTheDocument();
});

it("prices the answer in this lane's words, never the document lane's", async () => {
  priceSheet.props = null;
  render(<AnswerRequestReview request={{ ...base, resolutionMode: "agent" }} requesterLabel="Peer" />);
  // Consent is captured on the review step, before a price is ever chosen.
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to Google Gemini/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Set a price" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Set a price" }));
  const description = String(priceSheet.props?.description ?? "");
  expect(description).toBeTruthy();
  // The sheet is Drive's control; the promise it states is not Drive's here.
  expect(description).not.toMatch(/file|drive|google|document/i);
  expect(description).toMatch(/memory/i);
  expect(description).toMatch(/After you approve/i);
  expect(description).toMatch(/pay this price only when it is ready/i);
  expect(description).toMatch(/verified payment releases/i);
});

it("shows exactly one step at a time, and the price step carries no consent or payout control", async () => {
  priceSheet.props = null;
  render(<AnswerRequestReview request={{ ...base, resolutionMode: "agent" }} requesterLabel="Peer" />);
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to Google Gemini/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Set a price" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Set a price" }));
  // Exactly one modal: the review form (question, Uses, checkbox, Set a
  // price / Don't allow) is gone once the price step is showing, and the
  // price step itself carries no checkbox, consent paragraph or payout
  // control -- those already happened on the review step above it.
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set a price" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Don't allow" })).not.toBeInTheDocument();
  expect(screen.queryByText(/payout/i)).not.toBeInTheDocument();
});

it("discloses a missing age and approves only recorded sex and location", async () => {
  const age = "attr.identity.identity_profile.declared_age";
  const sex = "attr.identity.identity_profile.sex";
  const location = "attr.travel.home_city";
  memory.retrieve.mockImplementation(async ({ approvedScopes }: { approvedScopes: string[] }) => ({
    projections: approvedScopes.map(scope => ({ scope, payload: scope === age ? {} : { value: "recorded" }, contentRevision: 1 })),
    unavailableScopes: [], complete: true, assertCurrent: async () => undefined,
  }));
  render(<AnswerRequestReview request={{ ...base, resolutionMode: "agent", proposedScopes: [
    { scope: age, label: "Age" }, { scope: sex, label: "Sex" }, { scope: location, label: "Location" },
  ] }} requesterLabel="Peer" />);
  expect(await screen.findByText(/Available for this answer: Sex, Location/)).toBeInTheDocument();
  expect(screen.getByText(/Not recorded: Age/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to Google Gemini/ }));
  fireEvent.click(screen.getByRole("button", { name: "Set a price" }));
  await act(async () => { await (priceSheet.props?.onSubmit as (amount: number) => void)(200); });
  await waitFor(() => expect(memory.approve).toHaveBeenCalledWith("test-id-token", "r", [sex, location], 200, true));
});

it("blocks pricing when source reads are unavailable", async () => {
  memory.retrieve.mockImplementation(async ({ approvedScopes }: { approvedScopes: string[] }) => ({
    projections: [], unavailableScopes: approvedScopes, complete: false, assertCurrent: async () => { throw new Error("unavailable"); },
  }));
  render(<AnswerRequestReview request={{ ...base, resolutionMode: "agent" }} requesterLabel="Peer" />);
  expect(await screen.findByText(/Could not verify: Food preferences/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to Google Gemini/ }));
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  expect(memory.approve).not.toHaveBeenCalled();
});

it("rechecks available information before approving a priced answer", async () => {
  memory.retrieve
    .mockResolvedValueOnce({ projections: [{ scope: "attr.food.preferences", payload: { value: "recorded" }, contentRevision: 1 }],
      unavailableScopes: [], complete: true, assertCurrent: async () => undefined })
    .mockResolvedValueOnce({ projections: [{ scope: "attr.food.preferences", payload: {}, contentRevision: 2 }],
      unavailableScopes: [], complete: true, assertCurrent: async () => undefined });
  render(<AnswerRequestReview request={{ ...base, resolutionMode: "agent" }} requesterLabel="Peer" />);
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to Google Gemini/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Set a price" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Set a price" }));
  await act(async () => { await (priceSheet.props?.onSubmit as (amount: number) => void)(200); });
  await waitFor(() => expect(String(priceSheet.props?.error)).toMatch(/changed/));
  expect(memory.approve).not.toHaveBeenCalled();
});

it("does not silently add a newly available scope after the price step opens", async () => {
  const age = "attr.identity.identity_profile.declared_age";
  const sex = "attr.identity.identity_profile.sex";
  let ageRecorded = false;
  memory.retrieve.mockImplementation(async ({ approvedScopes }: { approvedScopes: string[] }) => ({
    projections: approvedScopes.map(scope => ({ scope, payload: scope === age && !ageRecorded ? {} : { value: "recorded" }, contentRevision: 1 })),
    unavailableScopes: [], complete: true, assertCurrent: async () => undefined,
  }));
  render(<AnswerRequestReview request={{ ...base, resolutionMode: "agent", proposedScopes: [
    { scope: age, label: "Age" }, { scope: sex, label: "Sex" },
  ] }} requesterLabel="Peer" />);
  expect(await screen.findByText(/Available for this answer: Sex/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to Google Gemini/ }));
  fireEvent.click(screen.getByRole("button", { name: "Set a price" }));
  ageRecorded = true;
  fireEvent.focus(window);
  await waitFor(() => expect(memory.retrieve).toHaveBeenCalledTimes(2));
  await act(async () => { await (priceSheet.props?.onSubmit as (amount: number) => void)(200); });
  await waitFor(() => expect(memory.approve).toHaveBeenCalledWith("test-id-token", "r", [sex], 200, true));
});
