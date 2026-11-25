import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { AdvisorRequestFlow } from "@/components/kai/advisor/advisor-request-flow";
import { reviewFixtureContext } from "./advisor-review-boundaries";
import finance from "@/components/kai/shared/finance-workspace.module.css";
const context = reviewFixtureContext(false);
function Preview() {
  const [open, setOpen] = useState(false);
  return <main className={`${finance.detail} mx-auto max-w-xl p-5`}>
    <p className="ui-text-helper-text">Finance · Sample profiles only</p>
    <ShellActionSurface variant="pill" onClick={() => setOpen(true)}>Start sample advisor request</ShellActionSurface>
    {open ? <AdvisorRequestFlow context={context} source={{ kind: "statement", snapshotId: null }}
      onClose={() => setOpen(false)} onSent={() => setOpen(false)} /> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
