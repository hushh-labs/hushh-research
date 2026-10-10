// Inert app boundaries for the persistent bottom chrome fixture. The shell,
// the navigation pill, the "Talk to One" bar and the live voice dock render
// from production source; only auth, routing, the microphone owner and the
// voice socket are replaced, because none of them decide geometry.
import { useSyncExternalStore } from "react";

const noop = () => {};
const root = () => document.documentElement.dataset;
const router = { replace: noop, push: noop, prefetch: noop, back: noop };

export const usePathname = () => root().path || "/one/connect";
export const useRouter = () => router;
export const useSearchParams = () => new URLSearchParams();

export const useAuth = () => ({
  user: { uid: "fixture-owner" },
  isAuthenticated: true,
});
export const useVault = () => ({ isVaultUnlocked: true });
export const useConsentPendingSummaryCount = () => 0;
export const useFeedUnreadCount = () => 0;

/** `data-agent="live"` renders the One Live Voice dock; otherwise the command bar. */
export const useOneVoiceLiveEnabled = () => root().agent === "live";

const idleCommand = {
  view: { phase: "idle", message: "", transcript: "" },
  user: { uid: "fixture-owner" },
  recording: null,
  collapsed: false,
  setCollapsed: noop,
  startCapture: async () => {},
  finishCapture: async () => {},
  cancelCapture: noop,
  cancelTask: noop,
  run: noop,
  hapticCancel: noop,
  active: false,
};
const workingCommand = {
  ...idleCommand,
  view: {
    phase: "working",
    message: "Finding people near you",
    transcript: "Who is in my trusted circle right now?",
  },
  active: true,
};
const resultCommand = {
  ...idleCommand,
  view: { phase: "result", message: "Fixture command completed", transcript: "" },
  dismissResult: () => {
    root().command = "idle";
    window.dispatchEvent(new Event("fixture-command-change"));
  },
};
const subscribeCommand = (listener: () => void) => {
  window.addEventListener("fixture-command-change", listener);
  return () => window.removeEventListener("fixture-command-change", listener);
};
const commandSnapshot = () => root().command || "idle";
function useCommand() {
  const phase = useSyncExternalStore(subscribeCommand, commandSnapshot);
  return phase === "working" ? workingCommand : phase === "result" ? resultCommand : idleCommand;
}
export const useLocationCommand = useCommand;
export const useOptionalLocationCommand = () => {
  const command = useCommand();
  return command.view.phase === "idle" ? null : command;
};
export const useLocationCommandLive = () => ({ level: 0.4, elapsedMs: 4_000 });

const session = {
  state: { phase: "idle", error: null },
  enabled: true,
  start: async () => {},
  stop: noop,
  interrupt: noop,
  setMuted: noop,
  sendText: noop,
};
export const useVoiceSession = () => session;
export const useOptionalVoiceSession = () => session;

// The onboarding interaction surface reaches Firebase auth at import time.
export const useOptionalOneLocationInteractionSurface = () => null;
// The voice panel's tool-result card imports an authenticated action gateway
// at module initialization. Geometry fixtures never render a tool result.
export const ToolResultCard = () => null;
