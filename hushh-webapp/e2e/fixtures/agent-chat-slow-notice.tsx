import { createRoot } from "react-dom/client";
import { Toaster } from "../../components/ui/sonner";
import { createSlowNoticeToastPort } from "../../components/agent/agent-chat-slow-notice";
import {
  SlowTurnNotice,
  slowNoticeView,
  type SlowNoticeState,
} from "../../lib/agent/agent-chat-slow-notice";

/**
 * The slow-reply notice from the production port, inside the production
 * Toaster mounted exactly as `app/providers.tsx` mounts it, over a chat-shaped
 * page: a transcript and a composer fixed to the bottom above the home
 * indicator. The safe areas are an iPhone's (59 pt top, 34 pt bottom), set
 * through the same `--app-safe-area-*` tokens the native shell publishes.
 * Only the composer's field is a stand-in: the spec measures the notice
 * against its box, not its contents.
 */
declare global {
  interface Window {
    slowNotice: {
      show: (state: SlowNoticeState) => void;
      clear: () => void;
      /** Drive the real controller: begin a turn, raise, and report dismissals. */
      controller: SlowTurnNotice;
      dismissals: number;
    };
  }
}

const port = createSlowNoticeToastPort(() => {
  window.slowNotice.dismissals += 1;
  controller.dismissedByPerson();
});
const controller = new SlowTurnNotice(port);

window.slowNotice = {
  show: (state) => port.show(slowNoticeView(state)),
  clear: () => port.clear(),
  controller,
  dismissals: 0,
};

function Fixture() {
  return (
    <div data-one-chat-surface className="min-h-screen bg-[color:var(--one-chat-canvas)] text-foreground">
      <div className="px-3 pt-[calc(var(--top-inset,0px)+128px)] pb-40">
        <div className="mx-auto flex w-full max-w-[var(--app-bottom-shell-max-width)] flex-col gap-3">
          <div className="ml-auto max-w-[90%] rounded-[20px] bg-foreground/[0.06] px-4 py-2 text-sm leading-6">
            Plan my week around the launch
          </div>
        </div>
      </div>
      <form
        data-testid="fixture-composer-shell"
        className="fixed inset-x-0 bottom-0 px-3 pt-3 pb-[calc(var(--app-safe-area-bottom,0px)+12px)]"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="mx-auto w-full max-w-[var(--app-bottom-shell-max-width)]">
          <div data-testid="fixture-composer" className="h-14 rounded-[26px] bg-foreground/[0.045]" />
        </div>
      </form>
      <Toaster
        position="top-center"
        closeButton
        offset={{ top: "calc(var(--top-inset, 0px) + 12px)" }}
        mobileOffset={{ top: "calc(var(--top-inset, 0px) + 12px)", left: "1rem", right: "1rem" }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
