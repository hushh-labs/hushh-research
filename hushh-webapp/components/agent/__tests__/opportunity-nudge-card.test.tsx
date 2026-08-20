import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpportunityNudgeStack } from "@/components/agent/opportunity-nudge-card";
import { OneOpportunityService } from "@/lib/one-marketplace/opportunity-service";
import { OneMarketplaceService } from "@/lib/one-marketplace/service";

vi.mock("@/lib/one-marketplace/opportunity-service", () => ({
  OneOpportunityService: {
    listDue: vi.fn(),
    snooze: vi.fn(),
    dismiss: vi.fn(),
    markPublished: vi.fn(),
  },
}));

vi.mock("@/lib/one-marketplace/service", () => ({
  OneMarketplaceService: {
    listRequests: vi.fn(),
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
  },
}));

const dueSignal = {
  id: "opp_1",
  kind: "intent",
  domain: "travel",
  title: "Travel history may be valuable",
  body: "You can publish this section for offers.",
  source: "derived",
  status: "active",
  suggestedPriceCents: 1200,
  currency: "USD",
  metadata: {
    domainTitle: "Travel",
    topLevelScopePath: "travel",
  },
} as const;

const pendingRequest = {
  id: "req_1",
  status: "pending",
  buyerLabel: "A buyer",
  sliceName: "Travel preferences",
  message: "Can I review this?",
  priceCents: 1200,
  currency: "USD",
} as const;

async function findOpportunityTrigger(): Promise<HTMLButtonElement> {
  await screen.findByText("Marketplace opportunities");
  const trigger = screen
    .getAllByRole("button")
    .find((button): button is HTMLButtonElement => button.hasAttribute("aria-expanded"));
  expect(trigger).toBeDefined();
  return trigger!;
}

describe("OpportunityNudgeStack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(OneOpportunityService.listDue).mockResolvedValue([dueSignal]);
    vi.mocked(OneMarketplaceService.listRequests).mockResolvedValue([pendingRequest]);
  });

  it("renders marketplace opportunities as a collapsed accordion", async () => {
    render(
      <OpportunityNudgeStack
        userId="user_1"
        vaultOwnerToken="HCT:test"
        vaultKey="vault-key"
        onRequireUnlock={vi.fn()}
        variant="accordion"
      />
    );

    const trigger = await findOpportunityTrigger();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByText("A buyer wants access")).toBeInTheDocument();
    expect(screen.getByText("Travel history may be valuable")).toBeInTheDocument();
  });

  it("uses a chat-surface dismiss button without expanding the accordion", async () => {
    const onDismissPanel = vi.fn();
    render(
      <OpportunityNudgeStack
        userId="user_1"
        vaultOwnerToken="HCT:test"
        vaultKey="vault-key"
        onRequireUnlock={vi.fn()}
        variant="accordion"
        onDismissPanel={onDismissPanel}
      />
    );

    const trigger = await findOpportunityTrigger();
    const dismiss = screen.getByLabelText("Hide marketplace opportunities for this vault session");

    fireEvent.click(dismiss);

    expect(onDismissPanel).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not fetch opportunities while the chat surface is dismissed", async () => {
    render(
      <OpportunityNudgeStack
        userId="user_1"
        vaultOwnerToken="HCT:test"
        vaultKey="vault-key"
        onRequireUnlock={vi.fn()}
        variant="accordion"
        dismissed
      />
    );

    expect(screen.queryByText("Marketplace opportunities")).not.toBeInTheDocument();
    expect(OneOpportunityService.listDue).not.toHaveBeenCalled();
    expect(OneMarketplaceService.listRequests).not.toHaveBeenCalled();
  });

  it("renders preloaded opportunities without self-fetching", async () => {
    render(
      <OpportunityNudgeStack
        userId="user_1"
        vaultOwnerToken="HCT:test"
        vaultKey="vault-key"
        onRequireUnlock={vi.fn()}
        variant="accordion"
        signals={[dueSignal]}
        requests={[pendingRequest]}
      />
    );

    const trigger = await findOpportunityTrigger();
    fireEvent.click(trigger);

    expect(screen.getByText("A buyer wants access")).toBeInTheDocument();
    expect(screen.getByText("Travel history may be valuable")).toBeInTheDocument();
    expect(OneOpportunityService.listDue).not.toHaveBeenCalled();
    expect(OneMarketplaceService.listRequests).not.toHaveBeenCalled();
  });

  it("shows a bounded loading row for preloaded accordion state", async () => {
    render(
      <OpportunityNudgeStack
        userId="user_1"
        vaultOwnerToken="HCT:test"
        vaultKey="vault-key"
        onRequireUnlock={vi.fn()}
        variant="accordion"
        signals={[]}
        requests={[]}
        loading
      />
    );

    const trigger = await findOpportunityTrigger();
    fireEvent.click(trigger);

    expect(screen.getByText("Loading marketplace opportunities...")).toBeInTheDocument();
    expect(OneOpportunityService.listDue).not.toHaveBeenCalled();
    expect(OneMarketplaceService.listRequests).not.toHaveBeenCalled();
  });
});
