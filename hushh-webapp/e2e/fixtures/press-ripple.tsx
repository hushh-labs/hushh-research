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
import { useState } from "react";
import { ArrowRight, Send } from "../../components/icons";
import { AgentFollowUpSuggestions, AgentSuggestionList } from "../../components/agent/agent-follow-up-suggestions";
import { ShellActionSurface } from "../../components/app-ui/shell-action-surface";
import { AuthProviderButton } from "../../components/onboarding/AuthProviderButton";
import { EmailSignInSection } from "../../components/onboarding/EmailSignInSection";
import authStyles from "../../components/onboarding/AuthStepLight.module.css";
import { AppleIcon, GoogleIcon } from "../../lib/morphy-ux/social-icons";
import { Button as StockButton } from "../../components/ui/button";
import { Button as MorphyButton } from "../../lib/morphy-ux/button";
import {
  LOCATION_PEOPLE_ACTION_LABEL_CLASSNAME,
  LOCATION_PEOPLE_ACTION_TARGET_CLASSNAME,
} from "../../components/one-location/redesign/location-action-styles";

const ignoreEmailState = () => {};
const rejectEmailAuthentication = async () => { throw new Error("Layout fixture cannot authenticate"); };

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
  const [locationActionCount, setLocationActionCount] = useState(0);
  return (
    <main className="flex flex-col items-start gap-4 p-4" data-testid="press-ripple">
      <StockButton>Stock action</StockButton>
      <MorphyButton variant="blue" effect="fill" size="prominent" fullWidth>
        Create your One
        <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
      </MorphyButton>
      <div className={`${authStyles.shell} w-full max-w-[430px] space-y-3`} data-testid="auth-providers">
        <AuthProviderButton label="Continue with Apple" icon={<AppleIcon className={`size-6 ${authStyles.appleProviderIcon}`} />} className={authStyles.providerButton} />
        <AuthProviderButton label="Continue with Google" icon={<GoogleIcon className="size-6" />} className={authStyles.providerButton} />
        <AuthProviderButton label="Continue with Microsoft" className={authStyles.providerButton}
          icon={<span aria-hidden="true" className={`grid size-6 grid-cols-2 gap-[2px] ${authStyles.microsoftProviderIcon}`}>
            {["#f25022", "#7fba00", "#00a4ef", "#ffb900"].map(color => <span key={color} style={{ backgroundColor: color }} />)}
          </span>} />
        <EmailSignInSection disabled={false} onBusyChange={ignoreEmailState}
          onExpandedChange={ignoreEmailState} onAuthenticated={rejectEmailAuthentication} />
      </div>
      <AgentFollowUpSuggestions
        suggestions={["Show my week", "Draft a reply to Sam"]}
        onSelect={() => {}}
      />
      <AgentSuggestionList layout="starter-grid" label="Start a conversation" testId="starter-suggestions"
        suggestions={["Plan my week", "Explore my connected apps", "Remember something important"]} onSelect={() => {}} />
      <ShellActionSurface
        type="button"
        rippleEffect="fill"
        aria-label="Send message"
        className="border-transparent bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
      >
        <Send className="h-4 w-4" />
      </ShellActionSurface>
      <div className="flex gap-2" data-testid="location-people-actions">
        {["Share", "Ask"].map((label) => (
          <MorphyButton key={label} type="button" variant="none" effect="fade" size="compact"
            disableHoverRipple className={LOCATION_PEOPLE_ACTION_TARGET_CLASSNAME}
            onClick={() => setLocationActionCount((count) => count + 1)}>
            <span className={LOCATION_PEOPLE_ACTION_LABEL_CLASSNAME}>{label}</span>
          </MorphyButton>
        ))}
      </div>
      <output data-testid="location-action-count">{locationActionCount}</output>
      <LegacyChip />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
