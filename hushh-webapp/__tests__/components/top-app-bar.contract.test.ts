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
    const switcherScope = source.slice(
      source.indexOf("function isPersonaSwitchTopBarRoute"),
      source.indexOf("function normalizeTopBarPathname"),
    );

    expect(source).toContain("function normalizeTopBarPathname");
    expect(switcherScope).toContain("normalized === KAI_MARKET_PATH");
    expect(switcherScope).toContain(
      "normalized.startsWith(`${KAI_MARKET_PATH}/`)",
    );
    expect(switcherScope).not.toContain("LEGACY_KAI_HOME");
    expect(switcherScope).not.toContain("RIA_HOME");
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

  it("owns route-provided tabs inside the single AppTopShell", () => {
    const source = read("components/app-ui/top-app-bar.tsx");
    const tabs = read("components/app-ui/top-shell-tabs.tsx");
    const providers = read("app/providers.tsx");

    expect(source).not.toContain("AgentSectionDropdown");
    expect(source).not.toContain("WorkspaceTopTabs");
    expect(source).not.toContain('data-testid="top-app-bar-ria-cluster"');
    expect(source).not.toContain("const isRiaOnboardingScope");
    expect(source).not.toContain("const isRiaScope");
    expect(source).not.toContain("useKaiBottomChromeVisibility");
    expect(source).not.toContain("bottom-chrome-progress");
    expect(source).not.toContain("topChromeHideProgress");
    expect(source).not.toContain("topChromeTransform");
    expect(source).not.toContain("topShellHeaderTransform");
    expect(source).not.toContain("topShellTabsTransform");
    expect(source).toContain('data-testid="top-app-bar-header"');
    expect(source).toContain('data-testid="top-app-bar-tabs"');
    expect(source).toContain("export function AppTopShell");
    expect(source).toContain('<AmbientChromeMask\n            edge="top"');
    expect(source).toContain("data-ambient-chrome-ignore");
    expect(source).not.toContain("bar-glass bar-glass-top");
    expect(source).toContain("ambient-chrome-top-foreground");
    expect(source).toContain("top-shell-ambient-ink");
    expect(source).toContain("<TopShellTabs tabSet={model.tabs} />");
    expect(source).not.toContain("resolveTopShellTabSet(");
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('role="tab"');
    expect(tabs).toContain(
      'tabSet.id === "ria" ? `ria_route_tab_${tab.value}`',
    );
    expect(tabs).toContain("aria-controls={topShellTabDomId");
    expect(tabs).toContain('event.key === "ArrowRight"');
    expect(tabs).toContain('event.key === "Home"');
    expect(source).not.toContain("topChromeHideDistance");
    expect(source).toContain('data-testid="app-top-shell-layout"');
    expect(source).not.toContain("max-xl:hidden");
    expect(source).not.toContain('aria-label="Search or ask One"');
    expect(source).toContain(
      '"calc(var(--top-inset) + var(--top-systembar-row-gap))"',
    );
    expect(source).not.toContain('height: "var(--top-shell-reserved-height)"');
    expect(source).not.toContain(
      '"pointer-events-none relative flex h-full w-full flex-col justify-end"',
    );
    expect(providers).toContain("<AppTopShell model={topShellModel} />");
    expect(providers).toContain("const topShellScrollResetKey =");
    expect(providers).toContain("topShellModel.tabs.activeValue");
    expect(providers).toContain("useScrollReset(topShellScrollResetKey");
    expect(providers).toContain("}, [topShellScrollResetKey]);");
    expect(providers).not.toContain("<TopAppBar />");
  });

  it("does not duplicate Location tabs inside the route body", () => {
    const locationHub = read(
      "components/one-location/redesign/location-redesign-hub.tsx",
    );

    expect(locationHub).not.toContain("<LocationLocalTabs");
    expect(locationHub).toContain("LOCATION_HUB_TAB_PARAM");
    expect(locationHub).toContain("<SwipeViews");
  });

  it("uses deterministic breadcrumb parents instead of browser history for top-bar back", () => {
    const source = read("components/app-ui/top-app-bar.tsx");
    const back = read("lib/navigation/top-shell-back.ts");

    expect(source).toContain("import { navigateTopShellBack }");
    expect(source).toContain("const handleTopShellBack");
    expect(source).toContain("onClick={handleTopShellBack}");
    expect(back).toContain("resolveTopShellBreadcrumb");
    expect(back).toContain(
      'mode: profilePanelOpen || locationActionOpen ? "replace" : "push"',
    );
    expect(back).toContain(
      "params.router[action.mode](action.href, { scroll: false })",
    );
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
    expect(source).toContain('model.brand === "one"');
    expect(source).toContain('data-testid="top-app-bar-one-brand"');
    expect(source).toContain('aria-label="One."');
    expect(source).toContain("app-accent-hero-from");
    expect(source).toContain("text-current");
    expect(source).not.toContain("AgentSectionDropdown");
    expect(source).toContain("<ActivityInbox />");
    expect(source).not.toContain("<ConsentInboxDropdown");
    expect(source).not.toContain("<DebateTaskCenter");
  });

  it("uses the shared Search Console-style mobile sheet without changing activity ownership", () => {
    const inbox = read("components/app-ui/activity-inbox.tsx");
    const tasks = read("components/app-ui/debate-task-center.tsx");
    const sheet = read("components/ui/sheet.tsx");

    expect(inbox).toContain("useIsMobile");
    expect(inbox).toContain("<Sheet modal open={open}");
    expect(inbox).toContain("<Activity className=");
    expect(inbox).not.toContain("<Heart className=");
    expect(inbox).not.toContain("<Shield");
    expect(inbox).toContain(
      'wrapperClassName={badgeCount > 0 ? "pr-5" : undefined}',
    );
    expect(inbox).toContain("<SheetContent");
    expect(inbox).not.toContain("useMobileSheetDragDismiss");
    expect(inbox).not.toContain(
      "onPointerMove={sheetDrag.onContentPointerMove}",
    );
    expect(inbox).toContain('overlayClassName="activity-inbox-sheet-overlay"');
    expect(inbox).toContain('presentation="section"');
    expect(inbox.match(/>Activity</g)).toHaveLength(3);
    expect(tasks).toContain(">Notifications</p>");
    expect(tasks).not.toContain(">Activity</p>");
    expect(sheet).toContain('data-slot="sheet-drag-handle"');
    expect(sheet).toContain("surface.scrollTop <= 0 && movedDown > 6");
    expect(sheet).toContain("distance > 96 || velocity > 0.5");
    expect(sheet).toContain('surface.style.animation = "none"');
  });

  it("keeps the rightmost signed-in Profile action in the shared top bar", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).not.toContain("WorkspaceTopTabs");
    expect(source).toContain('aria-label="Open Profile"');
    expect(source).toContain("requestInternalAppNavigation({");
    expect(source).toContain("href: ROUTES.PROFILE");
    expect(source).toContain('source: "tap"');
    expect(source).toContain('transitionMode: "full"');
    expect(source).not.toContain("onClick={() => router.push(ROUTES.PROFILE)}");
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
    expect(source).toContain(
      "'[data-testid=\"app-top-shell-layout\"]'",
    );
    expect(source).toContain("shell?.getBoundingClientRect().height");
    expect(source).not.toContain(
      'getPropertyValue("--top-shell-reserved-height");\n  const value = Number.parseFloat(raw);',
    );
    expect(source).toContain("new MutationObserver(scheduleHeaderRefresh)");
    expect(source).toContain("getScrolledRouteTitle(pathname)");
    expect(source).toContain('label: "Agents"');
    expect(source).toContain("const tabsOnlyChrome");
    expect(source).toContain("topChromeFullyCollapsed");
    expect(source).toContain("resolveTopChromeScrollProgress({");
    expect(source).toContain("previousY: lastScrollY");
    expect(source).not.toContain(
      'model.mode === "bar-with-tabs" && primaryHeaderOutOfView;',
    );
    expect(source).toContain('data-top-app-bar-tabs-only={tabsOnlyChrome || undefined}');
    expect(source).toContain('"calc(var(--top-inset) + var(--top-tabs-h))"');
    expect(source).toContain('paddingTop: tabsOnlyChrome ? "var(--top-inset)" : "0px"');
  });

  it("keeps background activity visible and adds locked-vault unlock action", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("showVaultUnlockAction");
    expect(source).toContain("VaultService.checkVault(user.uid)");
    expect(source).toContain('aria-label="Unlock vault"');
    expect(source).toContain("<KeyRound");
    expect(source).toContain("<ActivityInbox />");
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
    const back = read("lib/navigation/top-shell-back.ts");

    expect(source).toContain("breadcrumb: topShellBreadcrumb");
    expect(source).toContain("navigateTopShellBack({");
    expect(back).toContain("router: TopShellBackRouter");
    expect(source).not.toContain("history.back()");
  });

  it("keeps setup back as navigation and root completion explicit", () => {
    const topBar = read("components/app-ui/top-app-bar.tsx");
    const back = read("lib/navigation/top-shell-back.ts");
    const setupHub = read("components/onboarding/setup/one-setup-hub.tsx");
    const exitService = read("lib/services/one-setup-exit-service.ts");

    expect(topBar).not.toContain("acknowledgeOneSetupExit({");
    expect(topBar).toContain("navigateTopShellBack({");
    expect(back).toContain("resolveTopShellBackAction");
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
      '\'[data-slot="dropdown-menu-trigger"][data-state="open"]\'',
    );
    expect(chrome).toContain(
      '\'[data-slot="popover-trigger"][data-state="open"]\'',
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
