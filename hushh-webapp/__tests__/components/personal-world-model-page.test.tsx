import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PwmClaim, PwmMemory } from "@/lib/services/world-model-decision-service";

const mock = vi.hoisted(() => ({
  research: {} as Record<string, unknown>,
  claimable: false,
  load: vi.fn(),
  confirm: vi.fn(),
  reject: vi.fn(),
  edit: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/one/profile/world-model",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { uid: "owner-a", displayName: "Alice" },
    loading: false,
    sessionVerificationRequired: false,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "key-a",
    vaultOwnerToken: "token-a",
    isVaultUnlocked: true,
    tokenExpiresAt: null,
  }),
}));
vi.mock("@/components/profile/world-model-provider", () => ({
  useWorldModelResearch: () => mock.research,
}));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", () => ({
  createAgentPkmCaptureGuard: ({ isEnabled }: { isEnabled: () => boolean }) => ({
    isCurrent: () => isEnabled(),
    assertCurrent: async () => {
      if (!isEnabled()) throw new Error("stale");
    },
  }),
}));
vi.mock("@/lib/pkm/use-pkm-domain-change-revision", () => ({
  usePkmDomainChangeRevision: () => 0,
}));
vi.mock("@/lib/pkm/markdown-memory", () => ({ MARKDOWN_MEMORY_DOMAIN: "one_memory" }));
vi.mock("@/components/agent/profile-research-card", () => ({
  ProfileResearchCard: () => null,
}));
vi.mock("@/components/profile/world-model-claim-invitation", () => ({
  WorldModelClaimInvitation: ({ onClaimed }: { onClaimed?: () => void }) =>
    mock.claimable ? <button onClick={onClaimed}>Claim invitation</button> : null,
}));
vi.mock("@/components/profile/world-model-sources", () => ({
  WorldModelSources: () => <p>Claimed preview</p>,
}));
vi.mock("@/lib/services/world-model-decision-service", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/services/world-model-decision-service")>()),
  WorldModelDecisionService: {
    load: mock.load,
    confirm: mock.confirm,
    reject: mock.reject,
    edit: mock.edit,
    remove: mock.remove,
  },
}));

import { PersonalWorldModelPage } from "@/components/profile/personal-world-model-page";
import { pwmClaimKey } from "@/lib/services/world-model-decision-service";

const DRAFT_ID = "00000000-0000-4000-8000-000000000001";
const source = { title: "Hushh team page", url: "https://hushh.ai/team" };

function offered(
  facts: { statement: string; kind: string; confidence?: string }[],
  matchStatus: "matched" | "uncertain" | "no_match" = "matched",
) {
  return {
    status: "offered",
    pkm_written: false,
    draft_id: DRAFT_ID,
    report: {
      match_status: matchStatus,
      name: "Alice",
      summary: "Alice works on private agents.",
      sections: facts.map((fact) => ({
        kind: fact.kind,
        facts: [
          {
            statement: fact.statement,
            confidence: fact.confidence ?? "supported",
            sources: [source],
          },
        ],
      })),
    },
    grounded_answers: [{ answer: "RAW GROUNDED ANSWER", sources: [], search_suggestions: [] }],
    search_suggestions: [],
    research: { identity: { reason: "Same verified email on the team page." } },
  };
}

function memoryOf(saved: PwmClaim[] = [], decided: string[] = []): PwmMemory {
  return {
    claims: Object.fromEntries(saved.map((claim) => [claim.key, claim])),
    saved,
    decidedKeys: new Set([...saved.map((claim) => claim.key), ...decided]),
  };
}

async function claim(text: string, topic: PwmClaim["topic"] = "career"): Promise<PwmClaim> {
  return {
    key: await pwmClaimKey(text),
    decision: "accepted",
    text,
    topic,
    decided_at: "2026-10-15T10:00:00.000Z",
    basis: "owner_declaration",
  };
}

function research(result: unknown, preferences = { enabled: true, email_enabled: true }) {
  mock.research = {
    mounted: true,
    result,
    preferences: { ...preferences, consent_version: "pwm-native-v1" },
    failed: false,
    reload: vi.fn(),
    refresh: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.claimable = false;
  mock.load.mockResolvedValue(memoryOf());
});

describe("Personal World Model page", () => {
  it("shows a Yes only as saved after the encrypted memory write resolves", async () => {
    research(offered([{ statement: "Works at Hushh", kind: "career" }]));
    const saved = await claim("Works at Hushh");
    let finish!: (value: PwmMemory) => void;
    mock.confirm.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<PersonalWorldModelPage embedded />);

    expect(await screen.findByText("Ready to review")).toBeInTheDocument();
    expect(screen.getByText("1 detail to confirm.")).toBeInTheDocument();
    expect(screen.queryByText("RAW GROUNDED ANSWER")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes, this is right: Works at Hushh" }));
    expect(mock.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-a",
        vaultKey: "key-a",
        vaultOwnerToken: "token-a",
        statement: "Works at Hushh",
        topic: "career",
      }),
    );
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByText("Confirmed by you")).not.toBeInTheDocument();

    finish(memoryOf([saved]));
    expect(await screen.findByText("Confirmed by you")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Yes, this is right/ })).not.toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
  });

  it("keeps Yes and No with an error when the memory write fails", async () => {
    research(offered([{ statement: "Works at Hushh", kind: "career" }]));
    mock.confirm.mockRejectedValue(new Error("commit failed"));
    render(<PersonalWorldModelPage embedded />);

    fireEvent.click(await screen.findByRole("button", { name: "Yes, this is right: Works at Hushh" }));
    expect(await screen.findByText("Couldn’t save. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes, this is right: Works at Hushh" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "No, this isn’t right: Works at Hushh" })).toBeEnabled();
    expect(screen.queryByText("Confirmed by you")).not.toBeInTheDocument();
  });

  it("keeps a rejected statement hidden and never saves an opposite", async () => {
    research(offered([{ statement: "Likes blue", kind: "preferences" }]));
    const rejectedKey = await pwmClaimKey("Likes blue");
    mock.reject.mockResolvedValue(memoryOf([], [rejectedKey]));
    const { unmount } = render(<PersonalWorldModelPage embedded />);

    fireEvent.click(await screen.findByRole("button", { name: "No, this isn’t right: Likes blue" }));
    await waitFor(() => expect(screen.queryByText("Likes blue")).not.toBeInTheDocument());
    expect(mock.reject).toHaveBeenCalledWith(
      expect.objectContaining({ statement: "Likes blue", topic: "preferences" }),
    );
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(mock.edit).not.toHaveBeenCalled();
    // Every statement found was answered No: reviewed, not "nothing found".
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText("You’ve reviewed everything found so far.")).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t find public details/)).not.toBeInTheDocument();
    unmount();

    // A fresh session reads the decision back from memory; the draft stays gone.
    mock.load.mockResolvedValue(memoryOf([], [rejectedKey]));
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    expect(screen.queryByText("Likes blue")).not.toBeInTheDocument();
  });

  it.each([
    [
      "an offered report with no statements",
      { ...offered([], "no_match") },
      "Nothing to review yet",
      "We couldn’t find public details we could connect to you.",
    ],
    [
      "no active draft",
      { status: "saved", pkm_written: false },
      "Nothing to review right now",
      "We’ll check public sources again in a few days.",
    ],
    [
      "research in progress",
      { status: "pending", pkm_written: false, restart_required: false },
      "Preparing your model",
      "Your private agent is looking up public information about you. This takes a few minutes; keep using the app and we’ll let you know in Feed.",
    ],
  ])("says what is happening for %s", async (_case, result, title, body) => {
    research(result);
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
  });

  it("warns when details may be about someone else and tags them Unsure", async () => {
    research(offered([{ statement: "Lives in Austin", kind: "personal" }], "uncertain"));
    render(<PersonalWorldModelPage embedded />);

    expect(
      await screen.findByText(/Some details may be about someone else with your name/),
    ).toBeInTheDocument();
    const row = screen.getByText("Lives in Austin").closest("[data-testid='pwm-fact-row']")!;
    expect(within(row as HTMLElement).getByText("Unsure")).toBeInTheDocument();
  });

  it.each([
    ["uncertain", "supported", "Unsure – this may be about someone else with your name"],
    ["matched", "uncertain", "Unsure – limited or indirect evidence"],
    ["matched", "conflicting", "Sources disagree"],
  ] as const)(
    "explains a %s match with %s sources the way the row tags it",
    async (match, confidence, line) => {
      research(offered([{ statement: "Lives in Austin", kind: "personal", confidence }], match));
      render(<PersonalWorldModelPage embedded />);
      const statement = await screen.findByText("Lives in Austin");
      const row = statement.closest("[data-testid='pwm-fact-row']") as HTMLElement;
      expect(within(row).getByText("Unsure")).toBeInTheDocument();
      fireEvent.click(statement);
      expect(await screen.findByText(line)).toBeInTheDocument();
      // Negative control: a doubtful match never reads as source-backed.
      expect(screen.queryByText("Supported by sources")).not.toBeInTheDocument();
    },
  );

  it("offers Invite someone only once the model is usable", async () => {
    research({ status: "pending", pkm_written: false, restart_required: false });
    const { unmount } = render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Preparing your model")).toBeInTheDocument();
    expect(screen.getByText("Research and email")).toBeInTheDocument();
    // Adding a source never waits for a usable model; inviting does.
    expect(screen.getByText("Add a public source")).toBeInTheDocument();
    expect(screen.queryByText("Invite someone")).not.toBeInTheDocument();
    unmount();

    research({ status: "saved", pkm_written: false });
    mock.load.mockResolvedValue(memoryOf([await claim("Works at Hushh")]));
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Invite someone")).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
  });

  it("keeps the research switches reachable when preparing failed", async () => {
    mock.research = {
      mounted: true,
      result: null,
      preferences: null,
      failed: true,
      reload: vi.fn(),
      refresh: vi.fn(),
    };
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Couldn’t finish preparing your model.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Research and email"));
    expect(await screen.findByText("Checking your settings…")).toBeInTheDocument();
  });

  it("shows a claimed invitation's preview in Add a public source right away", async () => {
    mock.claimable = true;
    research({ status: "pending", pkm_written: false, restart_required: false });
    render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "Claim invitation" }));
    expect(await screen.findByRole("dialog", { name: "Add a public source" })).toBeInTheDocument();
    expect(screen.getByText("Claimed preview")).toBeInTheDocument();
  });

  it("moves focus to the next statement after a decision, then to the status", async () => {
    research(
      offered([
        { statement: "Lives in Austin", kind: "personal" },
        { statement: "Works at Hushh", kind: "career" },
      ]),
    );
    const austin = await claim("Lives in Austin", "personal");
    const hushh = await claim("Works at Hushh");
    mock.confirm
      .mockResolvedValueOnce(memoryOf([austin]))
      .mockResolvedValueOnce(memoryOf([austin, hushh]));
    render(<PersonalWorldModelPage embedded />);

    const first = await screen.findByRole("button", { name: "Yes, this is right: Lives in Austin" });
    first.focus();
    fireEvent.click(first);
    const next = await screen.findByRole("button", { name: "Yes, this is right: Works at Hushh" });
    await waitFor(() => expect(next).toHaveFocus());
    fireEvent.click(next);
    const status = (await screen.findByText("Up to date")).closest("[role='status']");
    await waitFor(() => expect(status).toHaveFocus());
  });

  it("locks the detail's choices while the row's decision is saving", async () => {
    research(offered([{ statement: "Works at Hushh", kind: "career" }]));
    let finish!: (value: PwmMemory) => void;
    mock.confirm.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<PersonalWorldModelPage embedded />);

    fireEvent.click(await screen.findByRole("button", { name: "Yes, this is right: Works at Hushh" }));
    fireEvent.click(screen.getByText("Works at Hushh"));
    const sheet = await screen.findByRole("dialog");
    const no = within(sheet).getByRole("button", { name: "No, this isn’t right: Works at Hushh" });
    expect(no).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Edit" })).toBeDisabled();
    fireEvent.click(no);
    expect(mock.reject).not.toHaveBeenCalled();

    // The row's decision lands; its stale detail closes rather than offering No again.
    finish(memoryOf([await claim("Works at Hushh")]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mock.confirm).toHaveBeenCalledTimes(1);
    expect(mock.reject).not.toHaveBeenCalled();
  });

  it("saves only the owner's corrected wording from the detail", async () => {
    research({ status: "saved", pkm_written: false });
    const saved = await claim("Works at Hushh");
    const corrected = await claim("Leads design at Hushh");
    mock.load.mockResolvedValue(memoryOf([saved]));
    mock.edit.mockResolvedValue(memoryOf([corrected], [saved.key]));
    render(<PersonalWorldModelPage embedded />);

    fireEvent.click(await screen.findByText("Works at Hushh"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Corrected wording"), {
      target: { value: "  Leads design at Hushh " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.edit).toHaveBeenCalledWith(
        expect.objectContaining({
          claimKey: saved.key,
          text: "Leads design at Hushh",
          topic: "career",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Corrected wording")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Leads design at Hushh")).toBeInTheDocument();
    expect(screen.queryByText("Works at Hushh")).not.toBeInTheDocument();
  });
});
