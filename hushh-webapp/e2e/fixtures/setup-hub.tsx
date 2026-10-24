import React from "react";
import { createRoot } from "react-dom/client";
import { OneSetupHub } from "../../components/onboarding/setup/one-setup-hub";
import { Button } from "../../lib/morphy-ux/button";
createRoot(document.getElementById("root")!).render(<>
  <div data-app-scroll-root="true" className="h-dvh overflow-y-auto overflow-x-hidden">
    <OneSetupHub />
  </div>
  <div aria-hidden="true" style={{position:"fixed",top:-1000}}>
    <Button data-testid="primary-reference" variant="blue" effect="fill" size="prominent" disabled>Finish setup</Button>
  </div>
</>);
