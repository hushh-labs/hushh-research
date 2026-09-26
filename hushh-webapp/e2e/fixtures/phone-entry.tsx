import React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../lib/morphy-ux/button";
import { PhoneMandatePageContent } from "../../app/register-phone/page";

createRoot(document.getElementById("root")!).render(<>
  <PhoneMandatePageContent />
  <div aria-hidden="true" style={{ position: "fixed", top: -1000, width: 300 }}>
    <Button data-testid="shared-primary-reference" variant="blue" effect="fill" size="prominent" fullWidth>Continue</Button>
  </div>
</>);
