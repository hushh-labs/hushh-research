import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Capture real rendered components; auth/data are fixtures, layout is production.
const root = process.cwd();
const sources = [
  "components/dashboard/one-dashboard-page.tsx", "components/dashboard/one-agent-roster.tsx",
  "components/dashboard/one-setup-progress-tile.tsx", "components/app-ui/settings-ui.tsx",
  "components/app-ui/app-page-shell.tsx", "components/app-ui/flow-actions.tsx",
  "components/app-ui/agent-section-icon.tsx", "components/app-ui/typography.tsx",
  "components/onboarding/setup/capability-list-row.tsx", "components/onboarding/setup/capability-cinematic-intro.tsx",
  "components/onboarding/setup/setup-completion-footer.tsx", "components/agent/specialist-directive-card.tsx",
  "lib/ui/button-variants.ts", "lib/morphy-ux/button.tsx", "lib/morphy-ux/utils.ts",
  "scripts/testing/capture-muse-review-fixtures.mjs",
];
const hash = createHash("sha256");
for (const file of sources) hash.update(readFileSync(path.join(root, file)));
const fingerprint = hash.digest("hex");
const output = path.join(root, "node_modules/.cache/muse-final-review/fixtures.json");
if (existsSync(output) && JSON.parse(readFileSync(output, "utf8")).fingerprint === fingerprint) process.exit(0);
mkdirSync(path.dirname(output), { recursive: true });
const capture = path.join(root, "__tests__", `.muse-capture-${process.pid}.test.tsx`);
const testSource = `
import { render, fireEvent, cleanup } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { it, expect, vi } from "vitest";
vi.mock("next/navigation", () => ({useRouter: () => ({push:vi.fn(),prefetch:vi.fn(),back:vi.fn()}),usePathname:()=>"/one",useSearchParams:()=>new URLSearchParams()}));
import { OneDashboardPage } from "@/components/dashboard/one-dashboard-page";
import { CapabilityListRow } from "@/components/onboarding/setup/capability-list-row";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { SpecialistDirectiveCard } from "@/components/agent/specialist-directive-card";
import { ONE_SETUP_CAPABILITIES } from "@/lib/onboarding/one-capabilities";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
it("captures production Home, setup and action card markup", () => {
 window.localStorage.clear(); window.sessionStorage.clear();
 const fixtures: Record<string, string> = {};
 const statuses = Object.fromEntries(ONE_SETUP_CAPABILITIES.map(c => [c.id,{id:c.id,state:"not-started",pendingCount:0,prerequisite:null,requiresUnlock:false}]));
 const home = render(<OneDashboardPage capabilityStatusById={statuses as any} />);
 fireEvent.click(home.getByRole("button",{name:"Show agent list view"}));
 fixtures.homeList = home.container.innerHTML;
 fireEvent.click(home.getByRole("button",{name:"Show agent grid view"}));
 expect(home.getByTestId("one-agents-grid")).toBeTruthy();
 fixtures.homeGrid = home.container.innerHTML; cleanup();
 const setup = render(<main className="mx-auto w-full max-w-[600px] p-4">
 <h1 className="ui-text-page-title mb-6">Set up One</h1>
 <div data-muse-setup-list="true"><SettingsGroup title="Not set up">{ONE_SETUP_CAPABILITIES.map(capability => {
 const copy=getCapabilitySetupCopy(capability.id); if(!copy) return null;
 return <CapabilityListRow key={capability.id} capability={capability} copy={copy} status={statuses[capability.id] as any} isDismissed={false} onRequestDismiss={()=>{}} onUndoDismiss={()=>{}}/>;
 })}</SettingsGroup></div>
 <SetupCompletionFooter label="Finish setting up One" controlId="fixture-finish" purpose="Finish" onComplete={()=>{}} insetBottom={false}/>
 </main>);
 fixtures.setup = setup.container.innerHTML; cleanup();
 const intro=render(<CapabilityCinematicIntroGate capabilityId="finance" introSupplement={<p className="ui-text-body max-w-[30rem]">Connect your accounts to see your finances together. You choose what to connect and can review access at any time.</p>}><p>Setup body</p></CapabilityCinematicIntroGate>);
 fixtures.intro=intro.container.innerHTML; cleanup();
 const action=render(<main className="mx-auto max-w-[600px] p-4"><SpecialistDirectiveCard summary="Review this action before continuing." confirmLabel="Confirm this request and share my selected information" onConfirm={()=>{}} onCancel={()=>{}}/></main>);
 fixtures.action=action.container.innerHTML; cleanup();
 writeFileSync(${JSON.stringify(output)},JSON.stringify({fingerprint:${JSON.stringify(fingerprint)},fixtures}));
});
`;
writeFileSync(capture, testSource);
try {
 execFileSync(process.execPath, [path.join(root,"node_modules/vitest/vitest.mjs"),"run",capture,"--maxWorkers=1"], {cwd:root,stdio:"inherit",env:{...process.env,TZ:"UTC"}});
} finally { unlinkSync(capture); }
