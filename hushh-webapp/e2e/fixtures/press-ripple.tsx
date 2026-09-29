// Fixture for e2e/press-ripple.layout.spec.ts.
//
// Renders the real press primitives and the controls named in the founder
// report: the core Buttons, the onboarding "Create your One" call to action
// (Morphy Button, as guest-preview renders it), the Apple sign-in button
// (AuthProviderButton, as AuthStep renders it), agent chat's follow-up chips
// and the composer's Send (ShellActionSurface on an accent fill).
//
// LegacyChip is a frozen copy of the follow-up chip markup before the fix,
// with a press scale added. It is the negative control: the spec runs the
// same measurements against it and requires them to FAIL.
import { createRoot } from "react-dom/client";
import { ArrowRight, Send } from "../../components/icons";
import { AgentFollowUpSuggestions } from "../../components/agent/agent-follow-up-suggestions";
import { ShellActionSurface } from "../../components/app-ui/shell-action-surface";
import { AuthProviderButton } from "../../components/onboarding/AuthProviderButton";
import { Button as StockButton } from "../../components/ui/button";
import { Button as MorphyButton } from "../../lib/morphy-ux/button";

function LegacyChip() {
  return (
    <button
      type="button"
      className="inline-flex !h-auto !min-h-11 max-w-full items-center gap-2 !rounded-2xl border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] !px-3.5 !py-2 text-left text-sm font-medium text-foreground transition-[transform] duration-100 active:scale-95"
    >
      Legacy chip
    </button>
  );
}

function Fixture() {
  return (
    <main className="flex flex-col items-start gap-4 p-4" data-testid="press-ripple">
      <StockButton>Stock action</StockButton>
      <MorphyButton variant="blue" effect="fill" size="prominent" fullWidth>
        Create your One
        <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
      </MorphyButton>
      <AuthProviderButton label="Continue with Apple" icon={null} />
      <AgentFollowUpSuggestions
        suggestions={["Show my week", "Draft a reply to Sam"]}
        onSelect={() => {}}
      />
      <ShellActionSurface
        type="button"
        rippleEffect="fill"
        aria-label="Send message"
        className="border-transparent bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
      >
        <Send className="h-4 w-4" />
      </ShellActionSurface>
      <LegacyChip />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
