import React from "react";
import { createRoot } from "react-dom/client";
import { GeminiRuntimeConfigurationPage } from "../../components/connections/gemini-runtime-configuration-page";
import { Button } from "../../lib/morphy-ux/button";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
publishValidatedAuthSessionPrincipal({ firebaseUid: "fixture", ownerId: "fixture", accountGeneration: 0 });
// Observe the production navigation request; this fixture has no application router.
window.addEventListener("app-internal-navigation-requested", (event) => {
  document.body.dataset.destination = (event as CustomEvent<{ href: string }>).detail.href;
});
createRoot(document.getElementById("root")!).render(<>
  <GeminiRuntimeConfigurationPage setupMode />
  <div aria-hidden="true" style={{position:"fixed",top:-1000}}>
    <Button data-testid="primary-reference" variant="blue" effect="fill" size="prominent" disabled>Finish setup</Button>
  </div>
</>);
