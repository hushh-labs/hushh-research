import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandPorts,
  CommandPresentation,
} from "@/lib/agent/location-command-runtime";
import type { OneSystemActionExecutor } from "@/lib/agent/one-system-action-executor";

const harness = vi.hoisted(() => ({
  pathname: "/one/agents",
  ports: null as CommandPorts | null,
  captureInstances: 0,
  runtimeInstances: 0,
  start: vi.fn(),
  finish: vi.fn(),
  cancelCapture: vi.fn(),
  haptic: vi.fn(),
  clearReferences: vi.fn(),
  pause: vi.fn(),
  recover: vi.fn(),
  submit: vi.fn(),
  transcribe: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
  navigate: vi.fn(),
  vault: {
    isVaultUnlocked: true,
    vaultOwnerToken: "synthetic-token",
    vaultKey: "synthetic-key",
  },
  user: { uid: "test-owner" },
  popover: {
    expanded: false,
    motionState: "closed",
    minimizeAgent: vi.fn(),
    openAgent: vi.fn(),
  },
  session: { busyOperations: {}, setAnalysisParams: vi.fn() },
  router: { push: vi.fn(), replace: vi.fn() },
  systemExecutor: null as OneSystemActionExecutor | null,
  submitAction: vi.fn(),
  runtime: null as { appRuntimeState: { route: { pathname: string } } } | null,
}));
vi.mock(
  "@/components/one-location/onboarding/location-onboarding-interaction-surface",
  () => ({ useOptionalOneLocationInteractionSurface: () => null }),
);
vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
  useRouter: () => harness.router,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: harness.user }),
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => harness.vault }));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({ switchPersona: vi.fn() }),
}));
vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: (selector: (value: unknown) => unknown) =>
    selector(harness.session),
}));
vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => harness.popover,
}));
vi.mock("@/lib/agent/agent-runtime-context", () => ({
  useAgentRuntimeStateOptional: () => harness.runtime,
}));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: (value: unknown) => harness.navigate(value),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("@capacitor/app", () => ({ App: {} }));
vi.mock("@/lib/voice/command-capture", () => ({
  CommandCapture: class {
    constructor() {
      harness.captureInstances++;
    }
    start = harness.start;
    finish = harness.finish;
    cancel = harness.cancelCapture;
    haptic = harness.haptic;
  },
}));
vi.mock("@/lib/agent/location-command-runtime", () => ({
  LocationCommandRuntime: class {
    constructor(ports: CommandPorts) {
      harness.runtimeInstances++;
      harness.ports = ports;
    }
    clearReferences = harness.clearReferences;
    pause = harness.pause;
    recover = harness.recover;
    submit = harness.submit;
    transcribe = harness.transcribe;
    cancel = harness.cancel;
    submitAction = harness.submitAction;
  },
}));
vi.mock("@/lib/agent/one-system-action-executor", () => ({
  registerOneSystemActionExecutor: (executor: OneSystemActionExecutor) => {
    harness.systemExecutor = executor;
    return () => {
      harness.systemExecutor = null;
    };
  },
}));
vi.mock("@/lib/agent/agent-action-runtime", () => ({
  executeAgentGatewayAction: vi.fn(),
}));
vi.mock("@/lib/agent/agent-gateway-action-settlement", () => ({
  settleAgentGatewayAction: vi.fn(),
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  getVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: {} }));
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: {},
}));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: {} }));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: {
    acquireVoiceLease: () => ({ release: harness.release }),
  },
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/components/agent/agent-voice-waveform", () => ({
  AgentVoiceWaveform: ({ level }: { level: number }) => (
    <output data-testid="meter">{level}</output>
  ),
}));
vi.mock("@/components/navbar", () => ({ Navbar: () => null }));
vi.mock("@/components/app-ui/ambient-chrome-mask", () => ({
  AmbientChromeMask: () => null,
}));

import { LocationCommandProvider } from "@/components/agent/location-command-provider";
import { AppBottomShell } from "@/components/app-ui/app-bottom-shell";
import {
  AGENT_CONVERSATION_REQUEST_EVENT,
  AGENT_CONVERSATION_CANCEL_EVENT,
} from "@/lib/agent/agent-voice-settings";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { ROUTES } from "@/lib/navigation/routes";

function App({
  hidden = false,
  onPage = vi.fn(),
}: {
  hidden?: boolean;
  onPage?: () => void;
}) {
  return (
    <LocationCommandProvider>
      <button onClick={onPage}>Page action</button>
      <AppBottomShell
        model={{ hidden, navigationHidden: hidden, ambientEnabled: false }}
      />
    </LocationCommandProvider>
  );
}
const mic = () => screen.getByTestId("one-voice-agent-bar-start-icon");
const down = (x = 200) =>
  fireEvent.pointerDown(mic(), {
    pointerId: 1,
    isPrimary: true,
    pointerType: "touch",
    button: 0,
    clientX: x,
  });
const up = (x = 200) =>
  fireEvent.pointerUp(mic(), {
    pointerId: 1,
    isPrimary: true,
    pointerType: "touch",
    button: 0,
    clientX: x,
  });
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
async function present(value: CommandPresentation) {
  await act(async () => harness.ports!.present(value));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  harness.captureInstances = 0;
  harness.runtimeInstances = 0;
  harness.pathname = "/one/agents";
  harness.runtime = null;
  window.history.replaceState({}, "", "/one/agents");
  harness.start.mockResolvedValue(undefined);
  harness.finish.mockResolvedValue({ audioBase64: "complete-final-words" });
  harness.cancelCapture.mockResolvedValue(undefined);
  harness.recover.mockResolvedValue(undefined);
  harness.submit.mockResolvedValue(undefined);
  harness.transcribe.mockResolvedValue("Do my Location onboarding");
  harness.cancel.mockImplementation(async () =>
    harness.ports!.present({ phase: "idle", message: "" }),
  );
  class Pointer extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    pointerType: string;
    constructor(type: string, init: PointerEventInit) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
      this.pointerType = init.pointerType ?? "touch";
    }
  }
  vi.stubGlobal("PointerEvent", Pointer);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mounted command bar", () => {
  it("ignores cancellation for an older or already accepted Siri request", async () => {
    let accepted!: () => void;
    harness.submit.mockImplementationOnce(async (_text, _id, onAccepted) => {
      accepted = onAccepted;
    });
    render(<App />);
    const pauses = harness.pause.mock.calls.length;
    fireEvent(
      window,
      new CustomEvent(AGENT_CONVERSATION_REQUEST_EVENT, {
        detail: {
          source: "siri_app_shortcut",
          requestId: "current",
          initialRequestText: "Do my Location onboarding",
        },
      }),
    );
    await flush();
    fireEvent(
      window,
      new CustomEvent(AGENT_CONVERSATION_CANCEL_EVENT, {
        detail: { source: "siri_app_shortcut", requestId: "old" },
      }),
    );
    expect(harness.pause).toHaveBeenCalledTimes(pauses);
    act(() => accepted());
    down();
    await flush();
    const recordingPauses = harness.pause.mock.calls.length;
    const cancellations = harness.cancelCapture.mock.calls.length;
    fireEvent(
      window,
      new CustomEvent(AGENT_CONVERSATION_CANCEL_EVENT, {
        detail: { source: "siri_app_shortcut", requestId: "current" },
      }),
    );
    expect(harness.pause).toHaveBeenCalledTimes(recordingPauses);
    expect(harness.cancelCapture).toHaveBeenCalledTimes(cancellations);
    expect(screen.getByText("Tap to send")).toBeInTheDocument();
  });
  it("cancels only the matching pending Siri request and ignores its late failure", async () => {
    let reject!: (reason: Error) => void;
    harness.submit.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    render(<App />);
    const pauses = harness.pause.mock.calls.length;
    fireEvent(
      window,
      new CustomEvent(AGENT_CONVERSATION_REQUEST_EVENT, {
        detail: {
          source: "siri_app_shortcut",
          requestId: "pending",
          initialRequestText: "Do my Location onboarding",
        },
      }),
    );
    fireEvent(
      window,
      new CustomEvent(AGENT_CONVERSATION_CANCEL_EVENT, {
        detail: { source: "siri_app_shortcut", requestId: "pending" },
      }),
    );
    await flush();
    expect(harness.pause).toHaveBeenCalledTimes(pauses + 1);
    await act(async () => {
      reject(Error("Old request failed"));
    });
    expect(screen.queryByText("Old request failed")).not.toBeInTheDocument();
  });
  it("settles a fast Connect-to-incoming-review redirect between navigation polls", async () => {
    const target = "/one/connect?reviewPerson=person-a";
    const destination = buildConsentCenterHref("pending", {
      requestId: "incoming-a",
      from: target,
    });
    harness.runtime = {
      appRuntimeState: {
        route: {
          get pathname() {
            return window.location.pathname + window.location.search;
          },
        },
      },
    };
    harness.navigate.mockImplementationOnce(() => {
      window.history.replaceState({}, "", destination);
      return true;
    });
    render(<App />);
    const opening = harness.ports!.navigate(target);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await expect(opening).resolves.toBe(true);
    expect(window.location.pathname).toBe(ROUTES.CONSENTS);
  });
  it("settles the canonical Links destination on a native exported pathname", async () => {
    harness.runtime = {
      appRuntimeState: {
        route: {
          get pathname() {
            return window.location.pathname + window.location.search;
          },
        },
      },
    };
    harness.navigate.mockImplementationOnce(() => {
      window.history.replaceState(
        {},
        "",
        "/one/location/index.html?view=links",
      );
      return true;
    });
    render(<App />);
    const opening = harness.ports!.navigate("/one/location?view=links");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await expect(opening).resolves.toBe(true);
  });
  it("rejects a typed Siri action during capture without replacing the microphone state", async () => {
    render(<App />);
    down();
    await flush();
    const result = await harness.systemExecutor!({
      id: "overlapping",
      kind: "execute_one_action",
      actionId: "location.pause_updates",
      slots: {},
      source: "siri_app_intent",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      requiresVault: true,
      confirmedBySystem: false,
    });
    expect(result.status).toBe("blocked");
    expect(harness.submitAction).not.toHaveBeenCalled();
    expect(screen.getByText("Tap to send")).toBeInTheDocument();
  });
  it("does not let a Siri text ingress replace an active microphone recording", async () => {
    render(<App />);
    down();
    await flush();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(AGENT_CONVERSATION_REQUEST_EVENT, {
          detail: {
            initialRequestText: "Do my Location onboarding",
            source: "siri",
            requestId: "overlapping",
          },
        }),
      ),
    );
    await flush();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(screen.getByText("Tap to send")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(250));
    up();
    await flush();
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });
  it("prepares on press, submits once on hold release and preserves the final recording", async () => {
    render(<App />);
    down();
    expect(harness.start).toHaveBeenCalledOnce();
    await flush();
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByText("Release to send")).toBeInTheDocument();
    up();
    fireEvent.click(mic(), { detail: 1 });
    await flush();
    expect(harness.finish).toHaveBeenCalledOnce();
    expect(harness.transcribe).toHaveBeenCalledWith("complete-final-words");
    expect(harness.submit).toHaveBeenCalledWith("Do my Location onboarding");
    expect(harness.start).toHaveBeenCalledOnce();
  });
  it("short tap latches recording; a second tap or keyboard activation finishes", async () => {
    render(<App />);
    down();
    await flush();
    up();
    fireEvent.click(mic(), { detail: 1 });
    expect(harness.finish).not.toHaveBeenCalled();
    expect(screen.getByText("Tap to send")).toBeInTheDocument();
    down();
    up();
    await flush();
    expect(harness.finish).toHaveBeenCalledOnce();
    await present({ phase: "idle", message: "" });
    fireEvent.click(mic(), { detail: 0 });
    await flush();
    fireEvent.click(mic(), { detail: 0 });
    await flush();
    expect(harness.finish).toHaveBeenCalledTimes(2);
  });
  it.each(["resolve", "reject"])(
    "release before readiness discards a late %s",
    async (completion) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      harness.start.mockReturnValueOnce(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      render(<App />);
      down();
      act(() => vi.advanceTimersByTime(300));
      up();
      await act(async () => {
        if (completion === "resolve") resolve();
        else reject(new Error("stale permission error"));
      });
      expect(harness.finish).not.toHaveBeenCalled();
      expect(harness.transcribe).not.toHaveBeenCalled();
      expect(
        screen.queryByText("stale permission error"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("one-voice-agent-bar")).toHaveAttribute(
        "data-command-capture-state",
        "idle",
      );
    },
  );
  it("arms cancellation at 64px and discards without submitting", async () => {
    render(<App />);
    down();
    await flush();
    fireEvent.pointerMove(mic(), { pointerId: 1, clientX: 136 });
    expect(screen.getByText("Release to cancel")).toBeInTheDocument();
    expect(harness.haptic).toHaveBeenCalledWith("cancel");
    up(136);
    await flush();
    expect(harness.finish).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
  });
  it("shows actual level and captured duration; backgrounding cancels", async () => {
    render(<App />);
    down();
    await flush();
    up();
    act(() =>
      harness.start.mock.calls[0]![2]({ level: 0.42, elapsedMs: 2300 }),
    );
    expect(screen.getByTestId("meter")).toHaveTextContent("0.42");
    expect(screen.getByLabelText("Recording duration")).toHaveTextContent(
      "0:02",
    );
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByTestId("one-voice-agent-bar")).toHaveAttribute(
      "data-command-capture-state",
      "idle",
    );
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });
  it("survives route/chrome changes and keeps the page usable with distinct collapse/cancel/dismiss", async () => {
    const onPage = vi.fn();
    const app = render(<App onPage={onPage} />);
    const initialPauses = harness.pause.mock.calls.length;
    await present({
      phase: "gate",
      message: "Allow location",
      gate: { kind: "permission", message: "Allow location" },
    });
    harness.pathname = "/one/setup/location/";
    app.rerender(<App hidden onPage={onPage} />);
    expect(harness.runtimeInstances).toBe(1);
    expect(harness.captureInstances).toBe(1);
    expect(harness.pause).toHaveBeenCalledTimes(initialPauses);
    fireEvent.click(screen.getByText("Page action"));
    expect(onPage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Collapse command"));
    expect(harness.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Show command"));
    fireEvent.click(screen.getByText("Cancel task"));
    await flush();
    expect(harness.cancel).toHaveBeenCalledOnce();
    app.rerender(<App />);
    await present({ phase: "result", message: "Location enabled" });
    fireEvent.click(screen.getByText("Dismiss result"));
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(mic()).not.toBeDisabled();
  });
  it("Chat ingress uses the same microphone owner and a stale finish cannot reopen progress", async () => {
    let finish!: (value: unknown) => void;
    harness.finish.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<App />);
    fireEvent(
      window,
      new CustomEvent(AGENT_CONVERSATION_REQUEST_EVENT, {
        detail: { source: "agent_chat" },
      }),
    );
    await flush();
    down();
    up();
    await flush();
    expect(mic()).toBeDisabled();
    expect(screen.getByText("Finishing recording…")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Cancel task"));
    await flush();
    await act(async () => finish({ audioBase64: "stale" }));
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.captureInstances).toBe(1);
  });
});
