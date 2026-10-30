import { mock, research } from "../fixtures/world-model-page-harness";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PersonalWorldModelPage, usePersonalWorldModelModel } from "@/components/profile/personal-world-model-page";
import { pwmClaimKey } from "@/lib/services/world-model-decision-service";
import { source, offered, memoryOf, claim, pending, provisionalFact } from "../fixtures/world-model-review";

  it("finds more from explicitly approved public citations while keeping saved Yes and No through new batches", async () => {
    const yes = await claim("Works at Hushh");
    const no = "Private rejected sentinel";
    const memory = memoryOf([yes], [await pwmClaimKey(no)]);
    mock.load.mockResolvedValue(memory);
    const complete = offered([{ statement: yes.text, kind: "career" }, { statement: no, kind: "career" }]);
    Object.assign(complete.research, { provider: "azure_openai_tavily" });
    research(complete);
    mock.research.preferences = { enabled: true, email_enabled: false, research_provider: "azure_openai_tavily" };
    const submit = vi.fn();
    mock.research.researchPublicProfiles = submit;
    const view = render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));
    const chooser = await screen.findByRole("dialog", { name: "Your details" });
    expect(submit).not.toHaveBeenCalled();
    expect(mock.research.refresh).not.toHaveBeenCalled();
    expect(within(chooser).getByTestId("public-leads").textContent).toBe(source.url);
    expect(within(chooser).queryByText(no)).toBeNull();
    fireEvent.click(within(chooser).getByRole("button", { name: "Research optional public links" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith([source.url]);
    const next = { ...provisionalFact, statement: "Maintains a public robotics project" };
    research(pending, undefined, { validatedFacts: [next, { ...next, statement: yes.text }, { ...next, statement: no }] });
    view.rerender(<PersonalWorldModelPage embedded />);
    expect(await screen.findByRole("button", { name: `Yes, this is right: ${next.statement}` })).toBeInTheDocument();
    expect(screen.getByText(yes.text)).toBeInTheDocument();
    expect(screen.queryByText(no)).toBeNull();
    expect(screen.queryByRole("button", { name: "Update my model" })).toBeNull();
    view.unmount();
    render(<PersonalWorldModelPage embedded />);
    expect(await screen.findByText(yes.text)).toBeInTheDocument();
    expect(await screen.findByText(next.statement)).toBeInTheDocument();
    expect(screen.queryByText(no)).toBeNull();
  });

  it("refuses a retained refresh callback after an unreviewed finding arrives", async () => {
    const yes = await claim("Works at Hushh");
    mock.load.mockResolvedValue(memoryOf([yes]));
    research(offered([{ statement: yes.text, kind: "career" }]));
    mock.research.preferences = { enabled: true, email_enabled: false, research_provider: "azure_openai_tavily" };
    const submit = vi.fn();
    mock.research.researchPublicProfiles = submit;
    const { result, rerender } = renderHook(() => usePersonalWorldModelModel());
    await waitFor(() => expect(result.current.canFindMore).toBe(true));
    // Native Google/Bing citations are not promoted to reusable stored leads.
    expect(result.current.publicSourceCandidates).toEqual([]);
    const retained = result.current.researchPublicProfiles;
    const retainedRefresh = result.current.refresh;
    mock.research.result = offered([{ statement: yes.text, kind: "career" }, { statement: "New unreviewed statement", kind: "projects" }]);
    rerender();
    await waitFor(() => expect(result.current.drafts).toHaveLength(1));
    act(() => { retained([source.url]); retainedRefresh(); });
    expect(submit).not.toHaveBeenCalled();
    expect(mock.research.refresh).not.toHaveBeenCalled();
    expect(result.current.canFindMore).toBe(false);
  });


  it("updates directly from saved details without opening the optional links chooser", async () => {
    const yes = await claim("Works at Hushh");
    mock.load.mockResolvedValue(memoryOf([yes]));
    research(offered([{ statement: yes.text, kind: "career" }]));
    mock.research.preferences = { enabled: true, email_enabled: false, research_provider: "azure_openai_tavily" };
    render(<PersonalWorldModelPage embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "Update my model" }));
    expect(mock.research.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
