import fs from 'fs';

const path = 'hushh-webapp/components/onboarding/setup/setup-capability-coordinator.tsx';
let code = fs.readFileSync(path, 'utf8');

// Replace the router.replace calls inside settle() to use the correct handoff target if the multi-step wizard is complete.
const target = `
        router.replace(ROUTES.ONE_SETUP);
        return {
          status: "succeeded",
          summary:
            kind === "finish"
              ? "Setup is complete. Returning to setup."
              : "Skipped for now. Returning to setup.",
          routeAfter: ROUTES.ONE_SETUP,
          screenAfter: "one_setup_hub",
        };`;

const replacement = `
        const hasExplicitIncompleteSetup =
          !PreVaultUserStateService.isSetupResolved(journey) &&
          journey.setupCompleted === false &&
          journey.onboardingJourneyVersion === 1 &&
          journey.onboardingPhase !== null &&
          journey.onboardingPhase !== "root_completion";

        const targetRoute = hasExplicitIncompleteSetup
          ? ROUTES.ONE_SETUP
          : resolveCapabilityHandoffTarget(capabilityId);

        router.replace(targetRoute);
        return {
          status: "succeeded",
          summary:
            kind === "finish"
              ? "Setup is complete. Returning to setup."
              : "Skipped for now. Returning to setup.",
          routeAfter: targetRoute,
          screenAfter: hasExplicitIncompleteSetup ? "one_setup_hub" : undefined,
        };`;

code = code.replace(target, replacement);

fs.writeFileSync(path, code);
