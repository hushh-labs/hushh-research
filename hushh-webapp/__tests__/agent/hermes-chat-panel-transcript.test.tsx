import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyStatus: vi.fn(),
  link: { current: null as unknown },
  runAgent: vi.fn(),
  abortRun: vi.fn(),
}));

vi.mock("@/lib/services/puppy-one-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/services/puppy-one-service")>();
  return {
    ...original,
    fetchPuppyStatus: mocks.fetchPuppyStatus,
  };
});

vi.mock("@/lib/hermes/use-puppy-link", () => ({
  usePuppyLink: () => mocks.link.current,
}));

vi.mock("@/components/agent/puppy-model-picker", () => ({
  PuppyModelPicker: () => null,
}));

vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    abortRun() { mocks.abortRun(); }
    runAgent(
      params: unknown,
      handlers: Record<string, (arg: { event: unknown }) => void>,
    ) {
      return mocks.runAgent(params, handlers);
    }
  },
}));

import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";
import { PuppyOneSurface } from "@/components/agent/puppy-one-surface";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";
vi.mock("@/components/agent/puppy-resource-monitor", () => ({
  PuppyMachineSheet: () => null,
}));
import type { PuppyStatus } from "@/lib/services/puppy-one-service";
import { useEffect, useState } from "react";
import { activeAgentDockSeat, AgentDockPortal, AgentDockProvider, AgentDockVoiceBoundary } from "@/components/agent/agent-dock";
import { AgentBarSurface, RetainedAgentBar } from "@/components/agent/agent-bar-surface";
import { NativeDockPortProvider, useNativeDockPorts, type NativeDockPort } from "@/components/agent/native-dock-port";
import type { DockEvent } from "@/lib/capacitor/native-dock";

/**
 * What the connected panel promises, how it says it, and how it reads.
 *
 * Three claims are load-bearing. The largest piece of copy on the surface must
 * not promise on-machine generation for a turn that was never pinned to the
 * machine. A failure must reach a screen reader without being gone looking
 * for, because One's own header status is deliberately silent in Puppy mode
 * and this panel is the only thing that can announce anything. And an answer
 * must render as prose, not as literal markdown: the on-device tier is not the
 * half of the product that looks unfinished.
 */

const CONNECTED: PuppyStatus = {
  connected: true,
  model: "gemma-4-26b-a4b-qat",
};

async function mount(status: PuppyStatus = CONNECTED) {
  mocks.fetchPuppyStatus.mockResolvedValue(status);
  mocks.link.current = null;
  const view = render(<HermesChatPanel />);
  await waitFor(() => expect(mocks.fetchPuppyStatus).toHaveBeenCalled());
  return view;
}

async function ask(text: string) {
  const composer = await screen.findByPlaceholderText("Ask Puppy One…");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send to Puppy One" }));
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.runAgent.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("HermesChatPanel empty state", () => {
  it.each([{ active: false }, { composerDisabled: true }])("rejects a queued Enter when the composer is no longer eligible: %j", async props => {
    const view = await mount();
    const editor = await screen.findByPlaceholderText("Ask Puppy One…");
    fireEvent.change(editor, { target: { value: "Unsent synthetic draft" } });
    view.rerender(<HermesChatPanel {...props} />);
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(editor).toHaveValue("Unsent synthetic draft");
  });
  it("shares the retained bar with Cloud while keeping each unsent draft isolated", async () => {
    const conversations: AgentChatConversation[] = ["a", "b"].map(id => ({
      id, title: id, status: "active", message_count: 0,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    }));
    function CloudComposer({ active }: { active: boolean }) {
      const [draft, setDraft] = useState("");
      return <AgentDockPortal enabled active={active} visible><AgentBarSurface embedded><textarea aria-label="Message One" value={draft} onChange={event => setDraft(event.target.value)} /></AgentBarSurface></AgentDockPortal>;
    }
    function Shell({ puppy, conversation = "a" }: { puppy: boolean; conversation?: string }) {
      return <AgentDockProvider>
        <AgentDockVoiceBoundary><RetainedAgentBar><AgentBarSurface><button>Talk to One</button></AgentBarSurface></RetainedAgentBar></AgentDockVoiceBoundary>
        <div hidden={!puppy}><PuppyOneSurface active={puppy} sharedDock conversations={conversations} activeConversationId={conversation} /></div>
        <div hidden={puppy}><CloudComposer active={!puppy} /></div>
      </AgentDockProvider>;
    }
    mocks.fetchPuppyStatus.mockResolvedValue(CONNECTED);
    mocks.link.current = null;
    const view = render(<Shell puppy={false} />);
    const seat = view.container.querySelector<HTMLDivElement>("[data-agent-dock-composer]")!;
    const cloud = screen.getByRole("textbox", { name: "Message One" }) as HTMLTextAreaElement;
    fireEvent.change(cloud, { target: { value: "Cloud-only draft" } });
    cloud.setSelectionRange(3, 8);
    view.rerender(<Shell puppy />);
    const puppy = await screen.findByRole("textbox", { name: "Message Puppy One" });
    fireEvent.change(puppy, { target: { value: "Puppy-only draft" } });
    (puppy as HTMLTextAreaElement).setSelectionRange(2, 7);
    expect(puppy.closest("[data-agent-dock-composer]")).toBe(seat);
    expect(activeAgentDockSeat(seat)).toBe(puppy.closest("[data-agent-dock-embedded]"));
    expect(screen.queryByRole("textbox", { name: "Message One" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Talk to One" })).toBeNull();
    expect(cloud.closest("[data-agent-dock-owner]")).toHaveAttribute("hidden");
    expect(cloud.closest("[data-agent-dock-owner]")).toHaveAttribute("inert");
    view.rerender(<Shell puppy={false} />);
    const returnedCloud = screen.getByRole("textbox", { name: "Message One" }) as HTMLTextAreaElement;
    expect(returnedCloud).toHaveValue("Cloud-only draft");
    expect(returnedCloud).toBe(cloud);
    expect([returnedCloud.selectionStart, returnedCloud.selectionEnd]).toEqual([3, 8]);
    expect(activeAgentDockSeat(seat)).toBe(cloud.closest("[data-agent-dock-embedded]"));
    expect(screen.queryByRole("textbox", { name: "Message Puppy One" })).toBeNull();
    expect(puppy.closest("[data-agent-dock-owner]")).toHaveAttribute("hidden");
    expect(puppy.closest("[data-agent-dock-owner]")).toHaveAttribute("inert");
    fireEvent.keyDown(puppy, { key: "Enter" });
    view.rerender(<Shell puppy />);
    const returnedPuppy = screen.getByRole("textbox", { name: "Message Puppy One" }) as HTMLTextAreaElement;
    expect(returnedPuppy).toHaveValue("Puppy-only draft");
    expect(returnedPuppy).toBe(puppy);
    expect([returnedPuppy.selectionStart, returnedPuppy.selectionEnd]).toEqual([2, 7]);
    expect(activeAgentDockSeat(seat)).toBe(puppy.closest("[data-agent-dock-embedded]"));
    view.rerender(<Shell puppy conversation="b" />);
    const otherPuppy = screen.getByRole("textbox", { name: "Message Puppy One" }) as HTMLTextAreaElement;
    expect(otherPuppy).not.toBe(puppy);
    fireEvent.change(otherPuppy, { target: { value: "Second Puppy draft" } });
    otherPuppy.setSelectionRange(1, 5);
    expect(activeAgentDockSeat(seat)).toBe(otherPuppy.closest("[data-agent-dock-embedded]"));
    view.rerender(<Shell puppy />);
    expect(screen.getByRole("textbox", { name: "Message Puppy One" })).toBe(puppy);
    expect(puppy).toHaveValue("Puppy-only draft");
    expect(activeAgentDockSeat(seat)).toBe(puppy.closest("[data-agent-dock-embedded]"));
    view.rerender(<Shell puppy conversation="b" />);
    expect(screen.getByRole("textbox", { name: "Message Puppy One" })).toBe(otherPuppy);
    expect([otherPuppy.selectionStart, otherPuppy.selectionEnd]).toEqual([1, 5]);
    expect(view.container.querySelectorAll("[data-agent-dock-composer]")).toHaveLength(1);
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });
  it("does not submit unfinished IME text; an ordinary Enter sends once", async () => {
    await mount();
    const editor = await screen.findByPlaceholderText("Ask Puppy One…");
    fireEvent.change(editor, { target: { value: "Synthetic composition" } });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(editor).toHaveValue("Synthetic composition");
    fireEvent.keyDown(editor, { key: "Enter", isComposing: false });
    await waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
  });
  it("promises on-machine generation only while the turn is pinned to it", async () => {
    await mount();
    expect(
      await screen.findByText(/generated on this machine/),
    ).toBeInTheDocument();
  });

  it("drops that promise when the pill is set to any model", async () => {
    // The pin is what makes the promise. With "any model" remembered from a
    // previous session the route sends no provider pin at all, so the gateway
    // is free to resolve a model that runs off this machine.
    window.localStorage.setItem("hussh.puppy.on_device", "0");
    await mount();
    expect(
      await screen.findByText(/not pinned to this machine/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/generated on this machine/),
    ).not.toBeInTheDocument();
    // The half that is true either way survives both arms.
    expect(screen.getByText(/separate from One/)).toBeInTheDocument();
  });
});

describe("HermesChatPanel on-device pin", () => {
  it("states the switch and drops the session rather than changing it invisibly", async () => {
    // Hermes applies provider and model at SESSION creation, so flipping the
    // pin mid-session would leave the pill claiming one thing while the
    // session already running answers another. Same treatment a model change
    // already gets.
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "on-device" }));

    expect(
      await screen.findByText(
        /Unpinned from this machine, so a model that runs off it may answer\./,
      ),
    ).toBeInTheDocument();
    // And the promise above the composer follows the pin in the same render.
    expect(screen.getByRole("button", { name: "any model" })).toBeInTheDocument();
  });

  it("writes that notice as the panel, never as the agent", async () => {
    // Once assistant turns render markdown and carry a copy button, an
    // app-authored sentence presenting as something the agent said is the same
    // class of lie as merging the transcripts.
    const view = await mount();
    fireEvent.click(await screen.findByRole("button", { name: "on-device" }));
    await screen.findByText(/Unpinned from this machine/);
    expect(
      view.container.querySelectorAll('button[aria-label="Copy answer"]'),
    ).toHaveLength(0);
  });
});

describe("HermesChatPanel transcript", () => {
  it("restores each selected Puppy's transcript and server session independently", async () => {
    mocks.fetchPuppyStatus.mockResolvedValue(CONNECTED);
    const conversations: AgentChatConversation[] = ["a", "b"].map((id) => ({
      id, title: id, status: "active", message_count: 0,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    }));
    let calls = 0;
    mocks.runAgent.mockImplementation(async (_params, handlers) => {
      calls++;
      handlers.onRunStartedEvent({ event: { runId: `session-${calls}` } });
      handlers.onTextMessageContentEvent({ event: { delta: `Answer ${calls}` } });
    });
    const view = render(<PuppyOneSurface conversations={conversations} activeConversationId="a" />);
    const sendAt = async (index: number, text: string) => {
      const textarea = view.container.querySelectorAll("textarea")[index];
      await waitFor(() => expect(textarea).not.toBeDisabled());
      fireEvent.change(textarea, { target: { value: text } });
      fireEvent.click(view.container.querySelectorAll('button[aria-label="Send to Puppy One"]')[index]);
      await waitFor(() => expect(textarea).not.toBeDisabled());
    };
    await sendAt(0, "First topic");
    view.rerender(<PuppyOneSurface conversations={conversations} activeConversationId="b" />);
    await sendAt(1, "Second topic");
    expect(mocks.runAgent.mock.calls[1][0].forwardedProps.sessionId).toBe("");
    view.rerender(<PuppyOneSurface conversations={conversations} activeConversationId="a" />);
    await sendAt(0, "Continue first topic");
    expect(mocks.runAgent.mock.calls[2][0].forwardedProps.sessionId).toBe("session-1");
    const panels = view.container.querySelectorAll("textarea");
    expect(panels[0].parentElement?.parentElement).toHaveTextContent("First topic");
    expect(panels[0].parentElement?.parentElement).not.toHaveTextContent("Second topic");
    expect(panels[1].parentElement?.parentElement).toHaveClass("hidden");
    view.rerender(<PuppyOneSurface conversations={[conversations[1]]} activeConversationId="b" />);
    expect(screen.queryByText("First topic")).not.toBeInTheDocument();
  });

  it("aborts an in-flight request on actual unmount, not when hidden", async () => {
    mocks.runAgent.mockImplementation(() => new Promise(() => {}));
    const view = await mount();
    await ask("Example");
    view.rerender(<HermesChatPanel active={false} className="hidden" />);
    expect(mocks.abortRun).not.toHaveBeenCalled();
    view.unmount();
    expect(mocks.abortRun).toHaveBeenCalledOnce();
  });
  it("keeps a polite status region mounted before any run begins", async () => {
    await mount();
    // Mounted with the panel, not inserted with its content: a live region
    // created in the same commit as its text is not reliably announced.
    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");
  });

  it("renders an answer as prose, not as literal markdown", async () => {
    mocks.runAgent.mockImplementation(
      async (
        _params: unknown,
        handlers: Record<string, (arg: { event: unknown }) => void>,
      ) => {
        handlers.onTextMessageContentEvent({
          event: { delta: "**Ready.** Here is a `plan`." },
        });
      },
    );
    const view = await mount();
    await ask("hello");

    await waitFor(() =>
      expect(view.container.querySelector("strong")).not.toBeNull(),
    );
    expect(view.container.querySelector("strong")).toHaveTextContent("Ready.");
    expect(view.container.querySelector("code")).toHaveTextContent("plan");
    // The literal asterisks are the symptom this replaces.
    expect(screen.queryByText(/\*\*Ready\.\*\*/)).not.toBeInTheDocument();
    // The owner's own words are NOT parsed as markdown.
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("announces a refusal rather than only colouring it", async () => {
    mocks.runAgent.mockRejectedValue(new Error("loopback down"));
    await mount();
    await ask("hello");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Puppy One is not answering on this machine.",
    );
  });
});

describe("HermesChatPanel secrets", () => {
  it("routes the actual native Puppy port through the same secret guard and preserves its draft when hidden", async () => {
    let port: NativeDockPort | undefined;
    function Observe() {
      const observed = useNativeDockPorts()?.get("text");
      useEffect(() => { port = observed; }, [observed]);
      return null;
    }
    function Shell({ active }: { active: boolean }) {
      return <NativeDockPortProvider><AgentDockProvider><HermesChatPanel active={active} sharedDock /><Observe /></AgentDockProvider></NativeDockPortProvider>;
    }
    mocks.fetchPuppyStatus.mockResolvedValue(CONNECTED);
    mocks.link.current = null;
    const view = render(<Shell active />);
    await waitFor(() => expect(port?.projection.editable).toBe(true));
    expect(port!.projection.editorLabel).toBe("Message Puppy");
    const context = port!.projection.context;
    const text = `my github token ${["gh", "p_", "fakefake0000fakefake0000fakefake0000"].join("")}`;
    act(() => port!.onEdit?.(text));
    await waitFor(() => expect(port?.projection.text).toBe(text));
    const event = (): DockEvent => ({ documentId: "synthetic", ownerEpoch: "synthetic", revision: 1, updateSequence: 1,
      sequence: 1, editRevision: 1, editorRevision: port!.projection.editorRevision, privacyGeneration: 0,
      context, kind: "action", action: "send", text: port!.projection.text, selectionStart: 0, selectionEnd: 0 });
    await act(async () => port!.onAction(event()));
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(port!.projection.text).toBe(text);
    view.rerender(<Shell active={false} />);
    expect(port).toBeUndefined();
    view.rerender(<Shell active />);
    await waitFor(() => expect(port?.projection.text).toBe(text));
    expect(port!.projection.context).toBe(context);
    act(() => port!.onEdit?.("Hello 世界\nA synthetic nonsecret request"));
    await act(async () => port!.onAction(event()));
    await waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
  });
  it("never sends a raw secret to Puppy, keeps the draft and says why (negative control)", async () => {
    await mount();
    const secret = ["gh", "p_", "fakefake0000fakefake0000fakefake0000"].join("");
    await ask(`my github token ${secret}`);
    expect(await screen.findByText(/holds a secret, so it stayed on this device/)).toBeInTheDocument();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Ask Puppy One…") as HTMLTextAreaElement).value).toContain(secret);

    await ask("what is on my calendar today");
    await waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));
  });
});
