import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { BootRouteCommitted, BootSurface } from "../../components/app-ui/boot-surface";
import { HushhLoader } from "../../components/app-ui/hushh-loader";
import type { BootStage, BootState } from "../../lib/boot/boot-sequence";
import {
  getBootSurfaceState,
  subscribeBootSurface,
} from "../../lib/boot/boot-surface-store";

/**
 * The production boot surface, mounted as `app/layout.tsx` mounts it, with a
 * stand-in guard chain that holds stages through the production
 * `HushhLoader stage=...` path. The spec drives the chain from the window:
 *
 * - `set(stage)` holds one stage (a guard waiting);
 * - `set("chat")` resolves to the first usable screen;
 * - `set("unlock")` resolves to the vault's interactive hard gate, painted at
 *   the sheet tier exactly as `VaultUnlockDialog` paints it.
 *
 * `legacy(stage)` instead renders the sequence the app shipped before: one
 * `HushhLoader` per guard, each its own screen in its own box (`min-h-[60vh]`
 * for the guards, `h-screen` for the chat entry). It is the negative control:
 * the spec's one-surface, no-shift assertions must fail on it.
 */

type LegacyStage = "session" | "vault" | "phone" | "setup" | "workspace" | "chat";

type View =
  | { mode: "new"; stage: BootStage | "chat" | "unlock" }
  | { mode: "legacy"; stage: LegacyStage };

declare global {
  interface Window {
    bootFixture: {
      set: (stage: BootStage | "chat" | "unlock") => void;
      legacy: (stage: LegacyStage) => void;
      state: () => BootState;
      /** Every phase the store has entered, in order. */
      phases: string[];
    };
  }
}

/** The pre-change HushhLoader, verbatim in markup and classes. */
function LegacyHushhLoader({ label, variant }: { label: string; variant: "fullscreen" | "page" }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-atomic="true"
      data-legacy-loader={label}
      className={`flex items-center justify-center text-muted-foreground ${
        variant === "fullscreen" ? "h-screen w-full" : "min-h-[60vh] w-full"
      }`}
    >
      <p className="text-sm motion-safe:animate-pulse">{label}</p>
    </div>
  );
}

const LEGACY: Record<Exclude<LegacyStage, "chat">, { label: string; variant: "fullscreen" | "page" }> = {
  // VaultLockGuard, PhoneMandateGuard, OnboardingJourneyGuard: page boxes.
  session: { label: "Checking session...", variant: "page" },
  vault: { label: "Checking vault...", variant: "page" },
  phone: { label: "Checking phone requirement...", variant: "page" },
  setup: { label: "Checking setup...", variant: "page" },
  // app/page.tsx chat entry: a full-screen box.
  workspace: { label: "Opening chat…", variant: "fullscreen" },
};

function ChatScreen() {
  return (
    <main data-testid="first-usable" className="min-h-screen bg-background px-4 pt-16 text-foreground">
      <h1 className="text-2xl font-semibold">Chat</h1>
      <p className="mt-2 text-sm text-muted-foreground">Ask One anything.</p>
    </main>
  );
}

function UnlockGate() {
  return (
    <div data-testid="vault-unlock-gate" className="fixed inset-0 bg-background" style={{ zIndex: 711 }}>
      <form
        className="mx-auto mt-24 flex max-w-sm flex-col gap-3 px-4"
        style={{ position: "relative", zIndex: 712 }}
        onSubmit={(event) => event.preventDefault()}
      >
        <h1 className="text-xl font-semibold text-foreground">Unlock One</h1>
        <input aria-label="Passphrase" className="h-11 rounded-full border px-4" />
      </form>
    </div>
  );
}

function initialView(): View {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const stage = params.get("stage") as BootStage | null;
  return { mode: "new", stage: stage ?? "chat" };
}

let setView: (view: View) => void = () => undefined;

function Fixture() {
  const [view, set] = useState<View>(initialView);
  useLayoutEffect(() => {
    setView = set;
  }, []);

  if (view.mode === "legacy") {
    if (view.stage === "chat") return <ChatScreen />;
    const legacy = LEGACY[view.stage];
    // Each guard painted its own loader: a separate screen per stage.
    return <LegacyHushhLoader key={view.stage} label={legacy.label} variant={legacy.variant} />;
  }

  const route =
    view.stage === "chat" ? (
      <ChatScreen />
    ) : view.stage === "unlock" ? (
      <UnlockGate />
    ) : (
      <HushhLoader key={view.stage} stage={view.stage} label={`detail ${view.stage}`} />
    );

  return (
    <>
      <BootSurface />
      <BootRouteCommitted />
      {route}
    </>
  );
}

const phases: string[] = [];
subscribeBootSurface(() => {
  const phase = getBootSurfaceState().phase;
  if (phases[phases.length - 1] !== phase) phases.push(phase);
});

window.bootFixture = {
  set: (stage) => setView({ mode: "new", stage }),
  legacy: (stage) => setView({ mode: "legacy", stage }),
  state: () => getBootSurfaceState(),
  phases,
};

createRoot(document.getElementById("root")!).render(<Fixture />);
