import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyStatus: vi.fn(),
  // What the shared link store would hand every surface on the page.
  link: { current: null as unknown },
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

import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";
import type { PuppyLink, PuppyStatus } from "@/lib/services/puppy-one-service";

/**
 * What a person sees when the bridge on the SERVER is not connected.
 *
 * On uat.one.hushh.ai and one.hushh.ai that is every person, always: the
 * loopback the bridge reaches is a container, not anyone's Mac. So the empty
 * state has to be driven by what One knows about the owner's machine, and
 * the developer's hint about a server env key has to stay on localhost.
 */

const NOT_CONFIGURED: PuppyStatus = {
  connected: false,
  reason: "not_configured",
  message:
    "Set HERMES_API_SERVER_KEY to talk to the Hermes agent on this machine.",
};

const GITHUB = "https://github.com/hushh-labs/hussh-one-hermes";
const DEVICES = "/one/profile/security/devices";

function link(overrides: Partial<PuppyLink>): PuppyLink {
  return {
    state: "unavailable",
    device: null,
    activeCount: 0,
    checkedAt: Date.now(),
    ...overrides,
  };
}

function device(overrides: Partial<NonNullable<PuppyLink["device"]>> = {}) {
  return {
    id: "dev-1",
    name: "Kushal's Mac",
    lastHeartbeatAt: Date.now() - 3 * 60_000,
    lastSyncedAt: null,
    heartbeat: null,
    ...overrides,
  };
}

const realLocation = window.location;

function setHostname(hostname: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, hostname, origin: `https://${hostname}` },
  });
}

async function mount(
  // Null is the pre-read sentinel the shared store hands every surface before
  // its first read lands. Every case here used to pass a real link, which is
  // exactly why the first-load window shipped reading as a failed check.
  value: PuppyLink | null,
  status: PuppyStatus = NOT_CONFIGURED,
) {
  mocks.fetchPuppyStatus.mockResolvedValue(status);
  mocks.link.current = value;
  const view = render(<HermesChatPanel />);
  await waitFor(() => expect(mocks.fetchPuppyStatus).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  setHostname("uat.one.hushh.ai");
});

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
});

describe("HermesChatPanel when the bridge is not connected", () => {
  it("live: names the machine, the model and when it was seen, and links the devices page", async () => {
    await mount(
      link({
        state: "live",
        activeCount: 1,
        device: device({
          heartbeat: { current_model: "gemma-4-26b-a4b-qat", busy: false },
        }),
      }),
    );

    expect(
      await screen.findByText(
        /Puppy One is connected to your account on Kushal's Mac · gemma-4-26b-a4b-qat · seen 3 minutes ago\. Chat here works from that machine\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trusted devices" })).toHaveAttribute(
      "href",
      DEVICES,
    );
    // The pill carries the device, in the colour that means live.
    expect(screen.getByText("connected · Kushal's Mac")).toBeInTheDocument();
    // The composer stays gated on the bridge, and says WHY in words that
    // agree with the green pill above it. "Puppy One is not connected" under
    // "connected · Kushal's Mac" was the contradiction this test used to pin.
    expect(
      screen.getByPlaceholderText("Chat with Puppy One from Kushal's Mac"),
    ).toBeDisabled();
    expect(screen.queryByPlaceholderText("Puppy One is not connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/HERMES_API_SERVER_KEY/)).not.toBeInTheDocument();
  });

  it("live: omits the model clause when the snapshot did not name one", async () => {
    await mount(link({ state: "live", activeCount: 1, device: device() }));
    expect(
      await screen.findByText(
        /Puppy One is connected to your account on Kushal's Mac · seen 3 minutes ago\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
  });

  it("quiet: says when the machine was last seen and how to check it", async () => {
    await mount(
      link({
        state: "quiet",
        activeCount: 1,
        device: device({ lastHeartbeatAt: Date.now() - 2 * 60 * 60_000 }),
      }),
    );
    const copy = await screen.findByText(/Puppy One on Kushal's Mac was last seen 2 hours ago/);
    // The human action leads. The state being explained is precisely the one
    // in which that machine is not available to type a slash command into, so
    // waking it is said first and the command is the fallback. No promise that
    // waking it works: quiet also covers a stopped gateway and a dead network.
    expect(copy).toHaveTextContent(
      "Puppy One on Kushal's Mac was last seen 2 hours ago. It answers only while that Mac is on and awake, so waking it is the first thing to try. If it stays quiet after that, run /hussh-one status on that machine.",
    );
    expect(copy).not.toHaveTextContent(/comes back/);
    expect(screen.getByText("last seen 2 hours ago")).toBeInTheDocument();
    // The only navigation this state can honestly offer, pinned the way the
    // live and unlinked states already pin theirs.
    expect(screen.getByRole("link", { name: "Trusted devices" })).toHaveAttribute(
      "href",
      DEVICES,
    );
    // The placeholder hedges to the same strength as the copy above it.
    expect(
      screen.getByPlaceholderText("Puppy One on Kushal's Mac is quiet right now"),
    ).toBeDisabled();
  });

  it("quiet: says the machine has not reported when it never has", async () => {
    await mount(
      link({
        state: "quiet",
        activeCount: 1,
        device: device({ lastHeartbeatAt: null }),
      }),
    );
    // Never reported is not "offline": the device is trusted and either older
    // than the heartbeat or between connecting and its first push.
    const copy = await screen.findByText(
      /Puppy One on Kushal's Mac is trusted but has not reported yet/,
    );
    expect(copy).not.toHaveTextContent(/asleep or offline/);
    // No wake instruction here: this device is not asleep, and saying so would
    // be a guess dressed as a fact.
    expect(copy).not.toHaveTextContent(/on and awake/);
    expect(screen.getByText("not connected")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Puppy One on Kushal's Mac has not reported yet"),
    ).toBeDisabled();
    expect(screen.getByRole("link", { name: "Trusted devices" })).toHaveAttribute(
      "href",
      DEVICES,
    );
  });

  it("unlinked: points at the install source and the devices page", async () => {
    await mount(link({ state: "unlinked" }));
    expect(
      await screen.findByText(/Puppy One isn't connected to your account yet/),
    ).toHaveTextContent(
      "Puppy One isn't connected to your account yet. Install it on your Mac, then run /hussh-one connect.",
    );
    const github = screen.getByRole("link", { name: "Get Puppy One on GitHub" });
    expect(github).toHaveAttribute("href", GITHUB);
    expect(github).toHaveAttribute("target", "_blank");
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Trusted devices" })).toHaveAttribute(
      "href",
      DEVICES,
    );
    expect(screen.getByText("not connected")).toBeInTheDocument();
  });

  it("revoked: says so and names the way back", async () => {
    await mount(link({ state: "revoked" }));
    expect(
      await screen.findByText(/Puppy One was unlinked from this account/),
    ).toHaveTextContent(
      // `connect`, not `reconnect`: the agent's own remedy for a revoked
      // (sealed) device, and `reconnect` refuses to run on one.
      "Puppy One was unlinked from this account. On that machine, run /hussh-one connect.",
    );
    // Unlinking can be done from another session or by someone else on the
    // account, so this is news, and Trusted devices is the only page that says
    // which device and when. Still no install anchor: that machine already has
    // Puppy One on it.
    expect(screen.getByRole("link", { name: "Trusted devices" })).toHaveAttribute(
      "href",
      DEVICES,
    );
    expect(
      screen.queryByRole("link", { name: "Get Puppy One on GitHub" }),
    ).not.toBeInTheDocument();
  });

  it("checking: says nothing about the machine before the first read lands", async () => {
    // The link store answers null until its first read lands, and that read
    // goes through a Firebase token plus a backend roundtrip while the bridge
    // status returns instantly on a deployed origin. Null (never asked) and
    // "unavailable" (asked, failed) used to render identically.
    await mount(null);
    expect(await screen.findByText("Checking Puppy One…")).toBeInTheDocument();
    expect(screen.getByText("checking…")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Checking Puppy One…")).toBeDisabled();
    // The two strings that belong to a FAILED read, and only to a failed read.
    expect(
      screen.queryByText("Couldn't check your Puppy One link right now."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("not connected")).not.toBeInTheDocument();
  });

  it("checking: holds that form even once the bridge has answered", async () => {
    // Frame two: `status` lands well before the link, so a gate on `status`
    // alone would leave the failure sentence painted for the whole link
    // window. This is the case that gate would miss.
    await mount(null, NOT_CONFIGURED);
    await waitFor(() => expect(mocks.fetchPuppyStatus).toHaveBeenCalled());
    expect(await screen.findByText("Checking Puppy One…")).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't check your Puppy One link right now."),
    ).not.toBeInTheDocument();
  });

  it("unavailable: admits the link could not be checked", async () => {
    await mount(link({ state: "unavailable" }));
    expect(
      await screen.findByText("Couldn't check your Puppy One link right now."),
    ).toBeInTheDocument();
    expect(screen.getByText("not connected")).toBeInTheDocument();
  });

  it("keeps the HERMES_API_SERVER_KEY hint off a deployed origin", async () => {
    setHostname("uat.one.hushh.ai");
    await mount(link({ state: "unlinked" }));
    await screen.findByText(/isn't connected to your account yet/);
    expect(screen.queryByText(/HERMES_API_SERVER_KEY/)).not.toBeInTheDocument();
  });

  it("shows the HERMES_API_SERVER_KEY hint on localhost, under the real state", async () => {
    setHostname("localhost");
    await mount(link({ state: "unlinked" }));
    const state = await screen.findByText(/isn't connected to your account yet/);
    const hint = screen.getByText(
      "Set HERMES_API_SERVER_KEY to talk to the Hermes agent on this machine.",
    );
    expect(hint).toBeInTheDocument();
    // Second line, not the headline.
    expect(
      state.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leaves the bridge's own pill alone when the bridge is connected", async () => {
    await mount(
      link({ state: "unlinked" }),
      { connected: true, model: "gemma-4-26b-a4b-qat" },
    );
    expect(await screen.findByText("gemma-4-26b-a4b-qat")).toBeInTheDocument();
    expect(screen.queryByText(/isn't connected to your account/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask Puppy One…")).not.toBeDisabled();
  });
});
