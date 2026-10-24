import { useState } from "react";
import { createRoot } from "react-dom/client";

import { TopShellTabs } from "../../components/app-ui/top-shell-tabs";
import { TOP_SHELL_TAB_REGISTRY } from "../../lib/navigation/top-shell-tabs";

function ConsentTabStrip() {
  const [value, setValue] = useState("requests");
  return (
    <main className="app-page-shell mx-auto max-w-[880px] px-[var(--page-inline-gutter-standard)]" data-consent-presentation="workspace">
      <TopShellTabs tabSet={{ ...TOP_SHELL_TAB_REGISTRY.consent, activeValue: value }} onValueChange={setValue} />
      <p data-testid="selected-consent-tab">{value}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ConsentTabStrip />);
