import { mock, clock, research, advance } from "../fixtures/world-model-page-harness";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PwmMemory } from "@/lib/services/world-model-decision-service";

import { PersonalWorldModelPage, usePersonalWorldModelModel } from "@/components/profile/personal-world-model-page";
import { pwmClaimKey } from "@/lib/services/world-model-decision-service";
import { WorldModelFactSheet, type WorldModelDraftFact } from "@/components/profile/world-model-fact-sheet";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

import { source, offered, memoryOf, claim, pending, progressOf, provisionalFact } from "../fixtures/world-model-review";

it("does not let a retained World Model detail consume another Profile page’s Back", () => {
  const close = vi.fn();
  const fact: WorldModelDraftFact = { kind: "draft", key: "public-detail", statement: "Public example", topic: "career",
    confidence: "supported", matchStatus: "matched", sources: [source], reason: "Public example" };
  const props = { fact, title: "Career", pathname: "/one", actions: { confirm: vi.fn(), reject: vi.fn(), edit: vi.fn(), remove: vi.fn() },
    onClose: close, backQuery: { profile_pane: "1", profile_panel: "world-model" } };
  const view = render(<WorldModelFactSheet {...props} />);
  act(() => { expect(unwindBackLayer("/one", new URLSearchParams("profile_pane=1&profile_panel=account"))).toBe(false); });
  expect(close).not.toHaveBeenCalled();
  act(() => { expect(unwindBackLayer("/one", new URLSearchParams("profile_pane=1&profile_panel=world-model"))).toBe(true); });
  expect(close).toHaveBeenCalledOnce();
  view.rerender(<WorldModelFactSheet {...props} present={false} />);
  act(() => { expect(unwindBackLayer("/one", new URLSearchParams("profile_pane=1&profile_panel=world-model"))).toBe(false); });
});

describe("Personal World Model page", () => {
  it("rejects retained statement callbacks after owner replacement and controller retirement", async () => {
    research(offered([{ statement: "Works at Hushh", kind: "career" }]));
    const view = renderHook(() => usePersonalWorldModelModel({ embedded: true }));
    await waitFor(() => expect(view.result.current.sections[0]?.drafts).toHaveLength(1));
    const fact = view.result.current.sections[0]!.drafts[0]!;
    const old = view.result.current.actions;
    act(() => view.result.current.setDetail(fact));
    mock.auth.user = { uid: "owner-b", displayName: "Bob" };
    view.rerender();
    expect(view.result.current.detail).toBeNull();
    await expect(old.confirm(fact)).rejects.toThrow("World model is no longer active");
    expect(mock.confirm).not.toHaveBeenCalled();
    const current = view.result.current.actions;
    view.unmount();
    await expect(current.confirm(fact)).rejects.toThrow("World model is no longer active");
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  it("does not let a late previous-owner commit suppress the new owner's pending read", async () => {
    research(offered([{ statement: "Works at Hushh", kind: "career" }]));
    const firstClaim = await claim("Works at Hushh");
    const nextClaim = await claim("Lives in a different city");
    let finishWrite!: (value: PwmMemory) => void, finishRead!: (value: PwmMemory) => void;
    mock.confirm.mockReturnValue(new Promise<PwmMemory>(resolve => { finishWrite = resolve; }));
    mock.load.mockImplementation(({ userId }) => userId === "owner-a" ? Promise.resolve(memoryOf()) :
      new Promise<PwmMemory>(resolve => { finishRead = resolve; }));
    const view = renderHook(() => usePersonalWorldModelModel({ embedded: true }));
    await waitFor(() => expect(view.result.current.sections[0]?.drafts).toHaveLength(1));
    const fact = view.result.current.sections[0]!.drafts[0]!;
    let writing!: Promise<void>;
    act(() => { writing = view.result.current.actions.confirm(fact); });
    expect(mock.confirm).toHaveBeenCalledTimes(1);
    mock.auth.user = { uid: "owner-b", displayName: "Bob" }; view.rerender();
    await waitFor(() => expect(finishRead).toBeTypeOf("function"));
    expect(view.result.current.pending.size).toBe(0);
    await act(async () => { finishWrite(memoryOf([firstClaim])); await writing; });
    await act(async () => { finishRead(memoryOf([nextClaim])); });
    await waitFor(() => expect(view.result.current.memory?.saved[0]?.text).toBe(nextClaim.text));
    expect(view.result.current.memory?.saved.some(item => item.text === firstClaim.text)).toBe(false);
  });
  it("waits calmly for the app-level reader instead of linking to its own route", async () => {
    // proxy.ts presents /one/profile/world-model as the Profile pane, so a
    // link to it from the pane would only reopen the pane.
    mock.research = {
      mounted: false,
      result: null,
      preferences: null,
      failed: false,
      progress: null,
      live: false,
      lastActivityAt: null,
      reload: vi.fn(),
      refresh: vi.fn(),
    };
    render(<PersonalWorldModelPage embedded />);
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent("Checking your model…");
    expect(screen.queryByText("Open Personal World Model")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(mock.push).not.toHaveBeenCalled();
    expect(mock.load).not.toHaveBeenCalled();
  });

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
    expect((await screen.findAllByText("Confirmed by you")).length).toBeGreaterThan(0);
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
    expect(screen.getByText(/You’ve reviewed everything found so far\./)).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t find public pages/)).not.toBeInTheDocument();
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
      "We couldn’t find public pages we can confidently connect to you. You can check again later.",
    ],
    [
      "no active draft",
      { status: "saved", pkm_written: false },
      "Nothing to review right now",
      "We’ll check public pages again in a few days.",
    ],
    [
      "a research check reaching its limit",
      { status: "unavailable", pkm_written: false, research_exhausted: true },
      "This check has ended",
      "Open Research and email to start a new check.",
    ],
    [
      "research just started",
      pending,
      "Preparing your model",
      "Starting…",
    ],
  ])("says what is happening for %s", async (_case, result, title, body) => {
    research(result);
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
  });

  it("warns when details may be about someone else and tags them Possible match", async () => {
    research(offered([{ statement: "Lives in Austin", kind: "personal" }], "uncertain"));
    render(<PersonalWorldModelPage embedded />);

    expect(
      await screen.findByText(/Possible match\. Some of these may be about someone else with your name/),
    ).toBeInTheDocument();
    const row = screen.getByText("Lives in Austin").closest("[data-testid='pwm-fact-row']")!;
    // The tag is the shared Badge, never an ad-hoc pill, and never "Unsure".
    const tag = within(row as HTMLElement).getByText("Possible match");
    expect(tag).toHaveAttribute("data-slot", "badge");
    expect(screen.queryByText("Unsure")).not.toBeInTheDocument();
    // The statement is a settings row in the group's compact density.
    expect(row).toHaveAttribute("data-settings-density", "compact");
    expect(within(row as HTMLElement).getByRole("button", { name: "Yes, this is right: Lives in Austin" })).toBeInTheDocument();
  });

  it("never leaves a doubtful statement without a source line", async () => {
    const report = offered([{ statement: "Lives in Austin", kind: "personal" }], "uncertain");
    report.report.sections[0]!.facts[0]!.sources = [];
    research(report);
    render(<PersonalWorldModelPage embedded />);
    const row = (await screen.findByText("Lives in Austin")).closest("[data-testid='pwm-fact-row']")!;
    expect(within(row as HTMLElement).getByText("May be about someone with your name")).toBeInTheDocument();
  });

  it.each([
    ["uncertain", "supported", "Possible match. This may be about someone else with your name."],
    ["matched", "uncertain", "Possible match. The sources only hint at this."],
    ["matched", "conflicting", "The sources disagree. Check before you say yes."],
  ] as const)(
    "explains a %s match with %s sources the way the row tags it",
    async (match, confidence, line) => {
      research(offered([{ statement: "Lives in Austin", kind: "personal", confidence }], match));
      render(<PersonalWorldModelPage embedded />);
      const statement = await screen.findByText("Lives in Austin");
      const row = statement.closest("[data-testid='pwm-fact-row']") as HTMLElement;
      expect(within(row).getByText("Possible match")).toBeInTheDocument();
      fireEvent.click(statement);
      expect(await screen.findByText(line)).toBeInTheDocument();
      // Negative control: a doubtful match never reads as source-backed.
      expect(screen.queryByText("Backed by the sources above")).not.toBeInTheDocument();
    },
  );

  it("offers Invite someone only once the model is usable", async () => {
    research(pending);
    const { unmount } = render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Preparing your model")).toBeInTheDocument();
    expect(screen.getByText("Research and email")).toBeInTheDocument();
    expect(screen.getByText("Add a public source")).toBeInTheDocument();
    expect(screen.queryByText("Invite someone")).not.toBeInTheDocument();
    unmount();

    research({ status: "saved", pkm_written: false });
    mock.load.mockResolvedValue(memoryOf([await claim("Works at Hushh")]));
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Invite someone")).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
  });

  it.each([
    ["bare server restart", { ...pending, restart_required: true }, true],
    ["live pending", pending, false],
    ["checkpoint restart", { ...pending, restart_required: true, progress: progressOf() }, false],
    ["empty checked facts", { ...pending, restart_required: true, validated_facts: [] }, false],
    ["paused work", { status: "paused", pkm_written: false, restart_required: true }, false],
  ])("offers explicit public-profile recovery only for %s", async (_label, result, available) => {
    research(result);
    const submit = vi.fn();
    mock.research.researchPublicProfiles = submit;
    mock.research.preferences = { enabled: true, email_enabled: false, consent_version: "pwm-azure-bing-v1", research_provider: "azure_openai_web_search" };
    render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByText("Add a public source"));
    const sources = await screen.findByRole("dialog", { name: "Add a public source" });
    expect(submit).not.toHaveBeenCalled();
    expect(mock.research.refresh).not.toHaveBeenCalled();
    if (available) {
      fireEvent.click(within(sources).getByRole("button", { name: "Research these profiles" }));
      expect(submit).toHaveBeenCalledExactlyOnceWith(["https://github.com/example-owner"]);
    } else expect(within(sources).queryByRole("button", { name: "Research these profiles" })).toBeNull();
  });

  it("keeps the research switches reachable when preparing failed", async () => {
    mock.research = {
      mounted: true,
      result: null,
      preferences: null,
      failed: true,
      progress: null,
      live: false,
      lastActivityAt: null,
      reload: vi.fn(),
      refresh: vi.fn(),
    };
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Couldn’t finish preparing your model")).toBeInTheDocument();
    // The note and its action sit under the card, Payouts-style.
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t refresh.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Research and email"));
    expect(await screen.findByText("Checking your settings…")).toBeInTheDocument();
  });

  it("shows Bing's privacy boundary before Azure research opt-in, while Vertex keeps Google copy", async () => {
    research({ status: "consent_required", pkm_written: false }, { enabled: false, email_enabled: true });
    const vertex = render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByText("Research and email"));
    expect(screen.getByText(/find pages about you with Google Search through Vertex AI/)).toBeInTheDocument();
    expect(screen.queryByText(/Bing may receive your name/)).not.toBeInTheDocument();
    vertex.unmount();

    research({ status: "consent_required", pkm_written: false }, { enabled: false, email_enabled: true });
    (mock.research.preferences as Record<string, unknown>).research_provider = "azure_openai_web_search";
    render(<PersonalWorldModelPage embedded />);
    const directOptIn = screen.getByText(/GPT-5 mini on Microsoft Azure AI plans searches/);
    expect(directOptIn).toHaveTextContent("Bing receives search terms that can include your name and verified email or phone");
    expect(directOptIn).toHaveTextContent("outside Azure's compliance and data residency boundary");
    expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
    fireEvent.click(await screen.findByText("Research and email"));
    expect(screen.getAllByText(/Bing receives search terms that can include your name and verified email or phone/)[0]).toHaveTextContent(
      "outside Azure's compliance and data residency boundary",
    );
  });

  it.each(["Hushh original title", ""])("shows an Azure grounded answer with its original UTF-16 citation and title %j", async (title) => {
    const draft = offered([{ statement: "Works at Hushh", kind: "career" }]);
    draft.research = {
      ...draft.research,
      provider: "azure_openai_web_search",
      source_use: "azure_web_grounded_display_only",
    };
    const answer = "Alex 🧭 appears on the Hushh team page.";
    const citationText = "Hushh team page";
    draft.grounded_answers = [{
      answer,
      sources: [],
      citations: [{
        start_index: answer.indexOf(citationText),
        end_index: answer.indexOf(citationText) + citationText.length,
        title,
        url: "https://hushh.ai/team?source=bing",
      }],
      search_suggestions: [],
    }];
    research(draft);
    render(<PersonalWorldModelPage embedded />);

    const result = await screen.findByTestId("pwm-azure-grounded-answer");
    expect(result.querySelector("p")?.textContent).toBe(answer);
    expect(within(result).getByRole("link", { name: citationText })).toHaveAttribute(
      "href", "https://hushh.ai/team?source=bing",
    );
    expect(within(result).getByRole("link", { name: title || "Public page" })).toHaveAttribute(
      "href", "https://hushh.ai/team?source=bing",
    );
    expect(screen.getByText("Bing web research")).toBeInTheDocument();
    expect(screen.queryByText("Related Google searches")).not.toBeInTheDocument();
  });

  it("keeps approved details and the last checkpoint visible after an unavailable result", async () => {
    const saved = await claim("Works at Hushh");
    mock.load.mockResolvedValue(memoryOf([saved]));
    research(
      { status: "unavailable", pkm_written: false },
      undefined,
      {
        progress: progressOf({ stage: "report" }),
        validatedFacts: [provisionalFact],
        lastActivityAt: Date.now(),
      },
    );
    render(<PersonalWorldModelPage embedded />);

    expect(await screen.findByText("Works at Hushh")).toBeInTheDocument();
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent("Your saved details remain below.");
    const checkpoint = screen.getByTestId("pwm-progress-row");
    expect(checkpoint).toHaveTextContent("Last research checkpoint · 9 of 32 searches");
    expect(checkpoint).toHaveTextContent("5 sources found · 4 topics checked");
    expect(screen.getByTestId("pwm-sources-row")).toHaveTextContent("Sources in last checkpoint");
    expect(screen.queryByTestId("pwm-progress-bar")).toBeNull();
    expect(screen.queryByText("Nothing was saved.")).toBeNull();
    expect(await screen.findByRole("button", { name: "Yes, this is right: Works at Acme Corp" })).toBeEnabled();
    expect(screen.getByText("To review")).toBeInTheDocument();
    expect(screen.getAllByText("Confirmed by you").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("reviews a streamed finding and shows confirmation only after a committed save", async () => {
    research(pending, undefined, {
      validatedFacts: [{ ...provisionalFact, identity_state: "candidate_for_review", confidence: "uncertain" }],
    });
    const saved = await claim(provisionalFact.statement);
    let finish!: (value: PwmMemory) => void;
    mock.confirm.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<PersonalWorldModelPage embedded />);
    const yes = await screen.findByRole("button", { name: `Yes, this is right: ${provisionalFact.statement}` });
    expect(screen.getByText("To review")).toBeInTheDocument();
    expect(screen.getByText("Possible match")).toBeInTheDocument();
    fireEvent.click(yes);
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByText("Confirmed by you")).not.toBeInTheDocument();
    await act(async () => { finish(memoryOf([saved])); });
    expect(screen.getAllByText("Confirmed by you").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Yes, this is right/ })).toBeNull();
    // The final model may omit a provisional finding; the owner's declaration remains.
    research(offered([]));
    view.rerender(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText(provisionalFact.statement)).toBeInTheDocument();
    view.unmount();
    mock.load.mockResolvedValue(memoryOf([saved]));
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText(provisionalFact.statement)).toBeInTheDocument();
  });

  it("withdraws an open streamed detail when its current batch revokes the finding", async () => {
    research(pending, undefined, { validatedFacts: [provisionalFact] });
    const view = render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByText(provisionalFact.statement));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    research(pending, undefined, { validatedFacts: [] });
    view.rerender(<PersonalWorldModelPage embedded />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(mock.edit).not.toHaveBeenCalled();
  });

  it("keeps a rejected stream finding hidden through later batches, final report and remount", async () => {
    const key = await pwmClaimKey(provisionalFact.statement);
    const rejected = memoryOf([], [key]);
    mock.reject.mockResolvedValue(rejected);
    research(pending, undefined, { validatedFacts: [provisionalFact] });
    const view = render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: `No, this isn’t right: ${provisionalFact.statement}` }));
    await waitFor(() => expect(screen.queryByText(provisionalFact.statement)).toBeNull());
    research(pending, undefined, { validatedFacts: [{ ...provisionalFact, statement: "  WORKS  at Acme Corp! " }] });
    view.rerender(<PersonalWorldModelPage embedded />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Yes, this is right/ })).toBeNull());
    research(offered([{ statement: provisionalFact.statement, kind: "career" }]));
    view.rerender(<PersonalWorldModelPage embedded />);
    await waitFor(() => expect(screen.queryByText(provisionalFact.statement)).toBeNull());
    view.unmount();
    mock.load.mockResolvedValue(rejected);
    render(<PersonalWorldModelPage embedded />);
    await waitFor(() => expect(mock.load).toHaveBeenCalled());
    expect(screen.queryByText(provisionalFact.statement)).toBeNull();
  });

  it("shows an immediate retry state while preserving the stopped checkpoint", async () => {
    research(null, undefined, {
      retrying: true,
      progress: progressOf({ stage: "report" }),
      live: false,
    });
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Retrying research…")).toBeInTheDocument();
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent("Checking the last research checkpoint.");
    expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("Last research checkpoint · 9 of 32 searches");
    expect(screen.queryByTestId("pwm-progress-bar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows a claimed invitation's preview in Add a public source right away", async () => {
    mock.claimable = true;
    research(pending);
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
    const status = (await screen.findByText("Up to date")).closest("[data-testid='pwm-status']");
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

  it("shows live progress while research runs: step, searches, bar and sources", async () => {
    research(pending, undefined, { progress: progressOf(), lastActivityAt: Date.now() });
    render(<PersonalWorldModelPage embedded />);

    const status = await screen.findByTestId("pwm-status-row");
    expect(status).toHaveTextContent("Preparing your model");
    // The step is the live line; the ticking topic count sits beside it.
    expect(within(status).getByRole("status")).toHaveTextContent(
      /^Step 2 of 3 · Searching public pages$/,
    );
    expect(status).toHaveTextContent("Step 2 of 3 · Searching public pages · 4 of 20 topics");
    const row = screen.getByTestId("pwm-progress-row");
    expect(row).toHaveTextContent("9 of 32 searches");
    expect(row).toHaveTextContent("5 sources found · 4 topics checked");
    const bar = screen.getByTestId("pwm-progress-bar");
    expect(bar).toHaveAttribute("role", "progressbar");
    // Counts are observed; a stage is not a completion percentage.
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(row).not.toHaveTextContent(/\d+%/);
    const sources = screen.getByTestId("pwm-sources-row");
    expect(sources).toHaveTextContent("Sources so far");
    expect(sources).toHaveTextContent("Acme Corp – Team · Example Uni – Alumni");
    expect(sources).toHaveTextContent("5");
    // Titles only while preparing; the final report carries the links.
    expect(within(sources).queryByRole("link")).toBeNull();
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent("Last activity just now");
    // The owner is told they need not wait here.
    expect(screen.getByText("You can leave this page. Research status will update here.")).toBeInTheDocument();
    // The clock ticks every 5 s while research runs.
    expect(clock.intervals).toContain(5_000);
    // Every card in the pane is compact, and nothing in it is a static block.
    for (const group of screen.getAllByTestId("settings-group"))
      expect(group).toHaveAttribute("data-settings-density", "compact");
  });

  it("shows observed counts and marks a resume without inventing a completion percentage", async () => {
    research(pending, undefined, { progress: progressOf(), lastActivityAt: Date.now() });
    const { rerender } = render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByTestId("pwm-progress-bar")).not.toHaveAttribute("aria-valuenow");
    // A paused turn can report a new slice with a different search count.
    research(
      { status: "paused", pkm_written: false, restart_required: true },
      undefined,
      { progress: progressOf({ searches_used: 2, topics_checked: ["career"], slice: 2 }), lastActivityAt: Date.now() },
    );
    rerender(<PersonalWorldModelPage embedded />);
    expect(screen.getByTestId("pwm-progress-bar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("2 of 32 searches");
    // A continued run says which part this is; the first run never does.
    expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("Continuing, part 2");
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent("Picking up again · Step 2 of 3");
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent(
      "Paused. Picking up where it left off…",
    );
  });

  it("does not call the report stage 90% complete", async () => {
    research(pending, undefined, {
      progress: progressOf({ stage: "report" }),
      lastActivityAt: Date.now(),
    });
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Step 3 of 3 · Writing up what it found")).toBeInTheDocument();
    expect(screen.getByTestId("pwm-progress-bar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.queryByText("90%")).toBeNull();
  });

  it("says it is reading sources when pages arrive without another search", async () => {
    research(pending, undefined, { progress: progressOf(), lastActivityAt: Date.now() });
    const { rerender } = render(<PersonalWorldModelPage embedded />);
    const line = () => within(screen.getByTestId("pwm-status-row")).getByRole("status");
    expect(await screen.findByTestId("pwm-status-row")).toBeInTheDocument();
    expect(line()).toHaveTextContent("Searching public pages");
    expect(screen.getByTestId("pwm-progress-row")).not.toHaveTextContent("Continuing");
    // More sources, same search count: the pages found are being read.
    research(pending, undefined, {
      progress: progressOf({ sources_found: 7 }),
      lastActivityAt: Date.now(),
    });
    rerender(<PersonalWorldModelPage embedded />);
    expect(line()).toHaveTextContent("Step 2 of 3 · Reading sources");
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent(
      "Step 2 of 3 · Reading sources · 4 of 20 topics",
    );
    // The next search spent means it is looking again.
    research(pending, undefined, {
      progress: progressOf({ sources_found: 7, searches_used: 10 }),
      lastActivityAt: Date.now(),
    });
    rerender(<PersonalWorldModelPage embedded />);
    expect(line()).toHaveTextContent("Searching public pages");
  });

  it("notes a possible match while research is still telling people apart", async () => {
    research(pending, undefined, {
      progress: progressOf({ stage: "identity", identity_state: "candidate_for_review", candidates: 2 }),
      lastActivityAt: Date.now(),
    });
    render(<PersonalWorldModelPage embedded />);
    expect(
      await screen.findByText("Possible match so far. You’ll confirm only what’s yours."),
    ).toHaveClass("profile-account-note");
  });

  it("announces the step only: a topic count ticking on its own stays quiet", async () => {
    research(pending, undefined, { progress: progressOf(), lastActivityAt: Date.now() });
    const { rerender } = render(<PersonalWorldModelPage embedded />);
    const status = await screen.findByTestId("pwm-status-row");
    const before = within(status).getByRole("status").textContent;
    expect(status).toHaveTextContent("4 of 20 topics");
    research(pending, undefined, {
      progress: progressOf({ topics_checked: [...progressOf().topics_checked, "projects"] }),
      lastActivityAt: Date.now(),
    });
    rerender(<PersonalWorldModelPage embedded />);
    expect(status).toHaveTextContent("5 of 20 topics");
    expect(within(status).getByRole("status").textContent).toBe(before);
  });

  it("draws a visible working bar before any progress is counted", async () => {
    research(pending, undefined, { progress: null, lastActivityAt: Date.now() });
    render(<PersonalWorldModelPage embedded />);
    const bar = await screen.findByTestId("pwm-progress-bar");
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    // A part-width fill must not be translated out of the track.
    const fill = screen.getByTestId("pwm-progress-fill");
    expect(bar).toContainElement(fill);
    expect(fill.className).toMatch(/\bw-1\/3\b/);
    expect(fill.className).toMatch(/\banimate-pulse\b/);
    expect(fill.className).toMatch(/motion-reduce:animate-none/);
    for (const node of [bar, ...bar.querySelectorAll("*")])
      expect(node.getAttribute("style") ?? "").not.toMatch(/translateX\(-100%\)/);
  });

  it("says a turn is awaited when nothing has started yet", async () => {
    research(
      { status: "pending", pkm_written: false, restart_required: true },
      undefined,
      { progress: null, live: true, lastActivityAt: Date.now() },
    );
    render(<PersonalWorldModelPage embedded />);
    const status = await screen.findByTestId("pwm-status-row");
    expect(within(status).getByRole("status")).toHaveTextContent("Starting shortly…");
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent(
      "Waiting for a turn. Starting shortly…",
    );
    expect(screen.queryByText(/Picking up/)).toBeNull();
  });

  it("offers Try again when a promised resume has gone quiet for too long", async () => {
    const reload = vi.fn();
    research(
      { status: "paused", pkm_written: false, restart_required: true },
      undefined,
      { progress: progressOf(), live: false, lastActivityAt: Date.now() - 10 * 60_000 },
    );
    mock.research.reload = reload;
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Research hasn't updated")).toBeInTheDocument();
    // The quiet spell wins over the promise of picking up again.
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent(
      "Taking longer than usual. No new research update.",
    );
    expect(screen.queryByText(/Picking up where it left off/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops showing a counting bar when bare pending research has gone quiet", async () => {
    research(
      { status: "pending", pkm_written: false, restart_required: true },
      undefined,
      { progress: null, live: true, lastActivityAt: Date.now() - 10 * 60_000 },
    );
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Research hasn't updated")).toBeInTheDocument();
    expect(screen.getByText("Try again to check for new results.")).toBeInTheDocument();
    expect(screen.queryByText("Counting what we find")).toBeNull();
    expect(screen.queryByTestId("pwm-progress-bar")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("moves focus to the status region when Try again or Turn on is used", async () => {
    mock.research = {
      mounted: true,
      result: null,
      preferences: null,
      failed: true,
      progress: null,
      live: false,
      lastActivityAt: null,
      retryAt: null,
      reload: vi.fn(),
      refresh: vi.fn(),
    };
    const { unmount } = render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(screen.getByTestId("pwm-status")).toHaveFocus();
    expect(mock.research.reload).toHaveBeenCalledTimes(1);
    unmount();

    research({ status: "consent_required", pkm_written: false }, { enabled: false, email_enabled: true });
    render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(screen.getByTestId("pwm-status")).toHaveFocus();
  });

  it("keeps the activity line ticking and offers Try again after a long quiet spell", async () => {
    const reload = vi.fn();
    research(pending, undefined, { progress: progressOf(), lastActivityAt: Date.now() });
    mock.research.reload = reload;
    render(<PersonalWorldModelPage embedded />);
    const line = await screen.findByTestId("pwm-freshness");
    expect(line).toHaveTextContent("Last activity just now");
    advance(9_000);
    expect(line).toHaveTextContent("Last activity just now");
    advance(56_000);
    // A minute in, the run's age joins the line; the ages are not announced.
    expect(line).toHaveTextContent("Started 1m ago · Last activity 1m ago");
    expect(within(line).getByRole("status")).toHaveTextContent("");
    advance(30_000);
    // The quiet spell is announced, once.
    expect(within(line).getByRole("status")).toHaveTextContent(
      "Still working. Nothing new in the last minute.",
    );
    advance(60_000);
    expect(line).toHaveTextContent("Still working. Nothing new in the last 2 minutes.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    advance(4 * 60_000);
    expect(line).toHaveTextContent(
      "Taking longer than usual. No new research update.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
    // The counters never cleared.
    expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("9 of 32 searches");
  });

  it("says it is reconnecting rather than going quiet when the live feed drops", async () => {
    research(pending, undefined, { progress: null, live: false, lastActivityAt: Date.now() });
    render(<PersonalWorldModelPage embedded />);
    const status = await screen.findByTestId("pwm-status-row");
    expect(within(status).getByRole("status")).toHaveTextContent("Reconnecting…");
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent(
      "Couldn’t get an update. Retrying…",
    );
    // No progress yet: the bar is indeterminate, the row still says what it counts.
    expect(screen.getByTestId("pwm-progress-bar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("Searching public pages");
  });

  it("shows what research looks for, with contacts masked", async () => {
    mock.auth.user = {
      uid: "owner-a",
      displayName: "Alice Example",
      email: "alice.example@example.com",
      emailVerified: true,
    };
    mock.auth.phoneNumber = "+14155550123";
    research(pending);
    render(<PersonalWorldModelPage embedded />);

    const name = await screen.findByTestId("pwm-identity-name");
    expect(name).toHaveTextContent("Alice Example");
    // The card says which verified details research pivots on, and its
    // landmark carries the same name.
    expect(screen.getByText("Using your name, email and phone")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Using your name, email and phone" }),
    ).toContainElement(name);
    const email = screen.getByTestId("pwm-identity-email");
    expect(email).toHaveTextContent("a•••@example.com");
    expect(email).not.toHaveTextContent("alice.example@");
    expect(within(email).getByText("Verified")).toHaveAttribute("data-slot", "badge");
    const phone = screen.getByTestId("pwm-identity-phone");
    expect(phone).toHaveTextContent("0123");
    expect(phone).not.toHaveTextContent("5550123");
    expect(within(phone).getByText("Verified")).toBeInTheDocument();
  });

  it("tells the owner what to add when identity is insufficient, with a way there", async () => {
    const onOpenAccount = vi.fn();
    research({ status: "insufficient_identity", pkm_written: false });
    render(<PersonalWorldModelPage embedded onOpenAccount={onOpenAccount} />);
    expect(
      await screen.findByText("Add your name and a verified email or phone"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("pwm-identity-email")).toHaveTextContent("Not added");
    fireEvent.click(screen.getByRole("button", { name: "Open your account" }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it.each(["matched", "uncertain"] as const)("preserves %s identity when review offers no new details", async (status) => {
    const report = offered([], status);
    report.research.candidates = [{ id: "c1", label: "Alice" }];
    research(report);
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("No new details to review")).toBeInTheDocument();
    expect(screen.queryByText(/none confirmed as you/)).toBeNull();
  });

  it("counts people with the owner's name when none was confirmed, and points to adding a page", async () => {
    const report = offered([], "no_match");
    report.research.candidates = [
      { id: "c1", label: "Alice, Austin" },
      { id: "c2", label: "Alice, Boston" },
    ];
    research(report);
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Nothing to review yet")).toBeInTheDocument();
    expect(
      screen.getByText("2 possible matches found, none confirmed as you."),
    ).toBeInTheDocument();
    expect(screen.getByText(/We couldn’t link a public page to your account/)).toHaveClass("profile-account-note");
  });

  it("waits out a research outage by the store's clock, then lets the owner ask again", async () => {
    const reload = vi.fn();
    research(
      {
        status: "unavailable",
        pkm_written: false,
        reason: "provider_unavailable",
        retry_after_s: 300,
      },
      undefined,
      { retryAt: Date.now() + 5 * 60_000 },
    );
    mock.research.reload = reload;
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Public search is paused right now")).toBeInTheDocument();
    const status = screen.getByTestId("pwm-status-row");
    expect(status).toHaveTextContent(
      "Your private agent can’t reach its research service. It will try again in about 5 minutes.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(reload).not.toHaveBeenCalled();
    advance(2 * 60_000);
    expect(status).toHaveTextContent("in about 3 minutes");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    // The wait is over: the owner may ask; the automatic retry is the store's.
    advance(3 * 60_000);
    expect(status).toHaveTextContent("You can try again now.");
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the true remaining wait when the pane reopens after the answer arrived", async () => {
    // The answer named 15 minutes; it arrived 20 minutes ago. A deadline taken
    // at render would restart the wait on every reopen.
    research(
      {
        status: "unavailable",
        pkm_written: false,
        reason: "provider_unavailable",
        retry_after_s: 900,
      },
      undefined,
      { lastActivityAt: Date.now() - 20 * 60_000, retryAt: Date.now() - 5 * 60_000 },
    );
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Public search is paused right now")).toBeInTheDocument();
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent("You can try again now.");
    expect(screen.getByTestId("pwm-status-row")).not.toHaveTextContent("15 minutes");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("waits out a short break that names no reason instead of offering a retry loop", async () => {
    const reload = vi.fn();
    research(
      { status: "unavailable", pkm_written: false, retry_after_s: 120 },
      undefined,
      { retryAt: Date.now() + 2 * 60_000 },
    );
    mock.research.reload = reload;
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("Research is taking a short break")).toBeInTheDocument();
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent(
      "It will try again in about 2 minutes.",
    );
    expect(screen.queryByText("Couldn’t finish preparing your model")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    advance(2 * 60_000);
    expect(screen.getByTestId("pwm-status-row")).toHaveTextContent("You can try again now.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("names the time of day for a longer research outage", async () => {
    research(
      {
        status: "unavailable",
        pkm_written: false,
        reason: "provider_unavailable",
        retry_after_s: 3_600,
      },
      undefined,
      { retryAt: Date.now() + 3_600_000 },
    );
    render(<PersonalWorldModelPage embedded />);
    const at = new Date(Date.now() + 3_600_000).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(await screen.findByText(`Your private agent can’t reach its research service. It will try again at ${at}.`)).toBeInTheDocument();
  });

  it("offers one explicit new check after exhaustion without an automatic retry loop", async () => {
    research({ status: "unavailable", pkm_written: false, research_exhausted: true });
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText("This check has ended")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByText("Research and email"));
    expect(await screen.findByText("Email me when it’s ready")).toBeInTheDocument();
    expect(mock.research.refresh).not.toHaveBeenCalled();
    expect(mock.research.reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Update my model"));
    expect(mock.research.refresh).toHaveBeenCalledTimes(1);
    expect(mock.research.reload).not.toHaveBeenCalled();
  });
});
