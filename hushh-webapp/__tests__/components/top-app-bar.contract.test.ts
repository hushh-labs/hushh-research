import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Top app bar responsive contract", () => {
  it("keeps the persona pill affordances visible on mobile and tablet", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("TOP_SHELL_TITLE_PILL_CLASSNAME");
    expect(source).not.toContain("hidden shrink-0 text-current sm:inline-flex");
    expect(source).not.toContain(
      "hidden h-1.5 w-1.5 shrink-0 rounded-full sm:inline-block",
    );
    expect(source).not.toContain(
      "hidden h-4 w-4 shrink-0 text-current/70 transition-colors group-hover:text-current sm:inline-block",
    );
    expect(source).toContain('className="shrink-0 text-current"');
    expect(source).toContain(
      'className="h-4 w-4 shrink-0 text-current/70 transition-colors group-hover:text-current"',
    );
  });

  it("keeps persona switching scoped to canonical Kai routes", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("function normalizeTopBarPathname");
    expect(source).toContain("normalized === ROUTES.KAI_HOME");
    expect(source).toContain("normalized.startsWith(`${ROUTES.KAI_HOME}/`)");
    expect(source).not.toContain("normalized === ROUTES.LEGACY_KAI_HOME");
    expect(source).not.toContain("normalized === ROUTES.RIA_HOME");
    expect(source).not.toContain(
      "normalized.startsWith(`${ROUTES.RIA_HOME}/`)",
    );
    expect(source).not.toContain("isProfileTopBarRoute(normalized)");
    expect(source).toContain("function isProfileTopBarRoute");
    expect(source).toContain(
      "centerTitle.interactive && canShowPersonaSwitcher",
    );
    expect(source).toContain("function roleSwitcherLabel");
    expect(source).toContain('label: "Profile"');
    expect(source).toContain("icon: UserRound");
    expect(source).toContain(
      'pathname === ROUTES.RIA_ONBOARDING && target === "investor"',
    );
    expect(source).toContain("router.push(nextRoute);");
  });

  it("keeps Finance and RIA workspace controls out of the top bar", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).not.toContain("AgentSectionDropdown");
    expect(source).not.toContain("WorkspaceTopTabs");
    expect(source).not.toContain('data-testid="top-app-bar-ria-cluster"');
    expect(source).not.toContain("const isRiaOnboardingScope");
    expect(source).not.toContain("const isRiaScope");
    expect(source).toContain("const topChromeHideProgress = rawTopChromeHideProgress;");
  });

  it("uses deterministic breadcrumb parents instead of browser history for top-bar back", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("router.push(topShellBreadcrumb.backHref, {");
    // Profile query-panels close via replace (mirrors the page's popProfileStack).
    expect(source).toContain("router.replace(topShellBreadcrumb.backHref, {");
    expect(source).not.toContain("router.back();");
  });

  it("preserves the reserved back slot without duplicating agent navigation", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain('data-testid="top-app-bar-nav-slot"');
    expect(source).toContain("resolveCommonRouteBreadcrumb");
    expect(source).not.toContain("AgentSectionDropdown");
  });

  it("renders the One home brand in the left slot without duplicating navigation", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("const showOneHomeBrand");
    expect(source).toContain("normalizedPathname === ROUTES.ONE_HOME");
    expect(source).toContain('data-testid="top-app-bar-one-brand"');
    expect(source).toContain("🤫 One");
    expect(source).not.toContain("AgentSectionDropdown");
    expect(source).toContain("<ConsentInboxDropdown");
    expect(source).toContain("<DebateTaskCenter");
  });

  it("keeps the rightmost signed-in Profile action in the shared top bar", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).not.toContain("WorkspaceTopTabs");
    expect(source).toContain('aria-label="Open Profile"');
    expect(source).toContain("router.push(ROUTES.PROFILE)");
    expect(source).toContain("<AvatarImage");
    expect(source).toContain("<AvatarFallback");
    expect(source).not.toContain('aria-label="Open Connect"');
  });

  it("uses primary header visibility for top-bar title handoff", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("primaryHeaderOutOfView");
    expect(source).toContain(
      '[data-slot="page-header"][data-page-primary="true"]',
    );
    expect(source).toContain("function isPrimaryHeaderOutOfView");
    expect(source).toContain(
      "header.getBoundingClientRect().bottom <= readTopShellReservedHeight()",
    );
    expect(source).toContain("getScrolledRouteTitle(pathname)");
    expect(source).toContain('label: "Agents"');
  });

  it("keeps background activity visible and adds locked-vault unlock action", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("showVaultUnlockAction");
    expect(source).toContain("VaultService.checkVault(user.uid)");
    expect(source).toContain('aria-label="Unlock vault"');
    expect(source).toContain("<KeyRound");
    expect(source).toContain("<DebateTaskCenter");
    expect(source).not.toContain(
      "Notifications unavailable until your vault is unlocked",
    );
  });

  it("keeps onboarding chrome canonical and shell-sized", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).not.toContain(
      'return { label: "Set up One", interactive: false as const };',
    );
    expect(source).not.toContain("ThemeToggleCompact");
    expect(source).toContain(
      '<ShellActionSurface variant="icon" aria-label="Account actions">',
    );
    expect(source).not.toContain(
      'return { label: "Get started", interactive: false as const };',
    );
    expect(source).not.toContain('className="h-9 w-9 rounded-full"');
  });
  it("preserves deterministic breadcrumb navigation contracts", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("topShellBreadcrumb.backHref");
    expect(source).toContain("router.push(topShellBreadcrumb.backHref, {");
    expect(source).not.toContain("history.back()");
  });

  it("keeps setup back as navigation and root completion explicit", () => {
    const topBar = read("components/app-ui/top-app-bar.tsx");
    const setupHub = read("components/onboarding/setup/one-setup-hub.tsx");
    const exitService = read("lib/services/one-setup-exit-service.ts");

    expect(topBar).not.toContain("acknowledgeOneSetupExit({");
    expect(topBar).toContain("router.push(topShellBreadcrumb.backHref, {");
    expect(setupHub).toContain("acknowledgeOneSetupExit({");
    expect(exitService).toContain("export function acknowledgeOneSetupExit");
    expect(exitService).toContain("primeOneSetupResolved({");
    expect(exitService).toContain(
      "writeOneSetupCompletionHint(params.userId, true);",
    );
    expect(exitService).toContain(
      "PreVaultUserStateService.primeSetupResolved",
    );
  });

  it("uses shared mobile-width chrome for top-shell shield and bell dropdowns", () => {
    const chrome = read("components/app-ui/top-shell-dropdown.tsx");
    const consentInbox = read("components/consent/consent-inbox-dropdown.tsx");
    const taskCenter = read("components/app-ui/debate-task-center.tsx");
    const shellActionSurface = read(
      "components/app-ui/shell-action-surface.tsx",
    );

    expect(chrome).toContain("export function TopShellDropdownContent");
    expect(chrome).toContain("export function TopShellPopoverContent");
    expect(chrome).toContain("centeredMobileAlignOffset");
    expect(chrome).toContain(
      "'[data-slot=\"dropdown-menu-trigger\"][data-state=\"open\"]'",
    );
    expect(chrome).toContain(
      "'[data-slot=\"popover-trigger\"][data-state=\"open\"]'",
    );
    expect(chrome).toContain("max-md:w-[calc(100vw-1.5rem)]");
    expect(chrome).toContain("max-md:min-w-[calc(100vw-1.5rem)]");
    expect(chrome).toContain("max-md:max-w-[calc(100vw-1.5rem)]");
    expect(chrome).toContain("TOP_SHELL_DROPDOWN_COLLISION_PADDING = 12");
    expect(consentInbox).toContain(
      "import {\n  TOP_SHELL_DROPDOWN_BODY_CLASSNAME",
    );
    expect(consentInbox).toContain("TopShellDropdownContent");
    expect(consentInbox).toContain('<TopShellDropdownContent align="end">');
    expect(taskCenter).toContain("TopShellDropdownContent");
    expect(taskCenter).toContain('<TopShellDropdownContent align="end">');
    expect(consentInbox).not.toContain("TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME");
    expect(taskCenter).not.toContain("TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME");
    // Lean header treatment: icon controls have no background chip and carry
    // the muted eyebrow tone on the stroke; only the pill variant keeps the
    // translucent track. The blue ripple stays shared across both.
    expect(shellActionSurface).toContain(
      "text-muted-foreground hover:text-foreground",
    );
    expect(shellActionSurface).toContain("bg-black/[0.05]");
    expect(shellActionSurface).toContain(
      '<MaterialRipple variant="blue" effect="glass"',
    );
  });

  it("clears every selection-driving consent detail param when the panel closes", () => {
    const source = read("components/consent/consent-center-page.tsx");

    expect(source).toContain("onOpenChange={(open) =>");
    expect(source).toContain("if (!open)");
    expect(source).toContain("requestId: null");
    expect(source).toContain("selected: null");
    expect(source).toContain("notificationAction: null");
  });
});
