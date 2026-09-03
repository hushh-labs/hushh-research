import {
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
    runAgent(
      params: unknown,
      handlers: Record<string, (arg: { event: unknown }) => void>,
    ) {
      return mocks.runAgent(params, handlers);
    }
  },
}));

import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";
import type { PuppyStatus } from "@/lib/services/puppy-one-service";

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
