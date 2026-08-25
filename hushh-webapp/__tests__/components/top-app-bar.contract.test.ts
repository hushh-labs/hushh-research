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
    expect(tabs).toContain(
      "setTopShellTabSwipeState(tabSet.id, index, false);",
    );
    expect(tabs).toContain(
      "calc(var(${topShellTabSwipePositionVariable(tabSet.id)}, ${activeIndex}) * 100%)",
    );
    expect(tabs).not.toContain(
      ': `translate3d(${activeIndex * 100}%, 0, 0)`',
    );
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
    const edgeBack = read("components/app-ui/app-edge-back-gesture.tsx");

    expect(source).toContain("import { navigateTopShellBack }");
    expect(source).toContain("const handleTopShellBack");
    expect(source).toContain("onClick={handleTopShellBack}");
    expect(back).toContain("resolveTopShellBreadcrumb");
    // An open panel or Location action closes in place; everything else is a
    // step in the trail and retraces.
    expect(back).toContain(
      "if (profilePanelOpen || locationActionOpen || connectCircleFlowOpen)",
    );
    expect(back).toContain('return action(breadcrumb.backHref, "replace")');
    expect(back).toContain("params.navigate(action);");
    expect(source).toContain("replace: action.mode === \"replace\"");
    expect(source).toContain('source: "tap"');
    // The resolver owns whether back is a screen change or an in-place close.
    // Both call sites pass its answer through; neither hardcodes a mode.
    expect(back).toContain('? "contextual"');
    expect(source).toContain("transitionMode: action.transitionMode");
    expect(edgeBack).toContain("requestInternalAppNavigation({");
    expect(edgeBack).toContain('source: "native_back"');
    expect(edgeBack).toContain("transitionMode: action.transitionMode");
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
    expect(source).not.toContain("<ActivityInbox");
    expect(source).not.toContain("<ConsentInboxDropdown");
    expect(source).not.toContain("<DebateTaskCenter");
  });

  it("keeps the rightmost signed-in Profile action in the shared top bar", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).not.toContain("WorkspaceTopTabs");
    expect(source).toContain('aria-label="Open Profile"');
    expect(source).toContain("requestInternalAppNavigation({");
    // The avatar opens Profile origin-aware (tags the current route as `?from`)
    // so the shared back control returns to where the user came from instead of
    // always dropping them on the One dashboard.
    expect(source).toContain("href: profileOpenHref");
    expect(source).toContain("const profileOpenHref");
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
    expect(source).toContain('label: "One"');
    expect(source).not.toContain('label: "Location", icon: MapPin');
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
    expect(source).not.toContain(
      "Notifications unavailable until your vault is unlocked",
    );
  });

  it("keeps onboarding chrome canonical and shell-sized", () => {
    const source = read("components/app-ui/top-app-bar.tsx");
    const signOutItemStart = source.indexOf(
      "onClick={() => void handleSignOut()}",
    );
    const signOutItemSource = source.slice(
      signOutItemStart,
      source.indexOf("</DropdownMenuItem>", signOutItemStart),
    );
    const deleteItemStart = source.indexOf('variant="destructive"');
    const deleteItemSource = source.slice(
      deleteItemStart,
      source.indexOf("</DropdownMenuItem>", deleteItemStart),
    );

    expect(source).not.toContain(
      'return { label: "Set up One", interactive: false as const };',
    );
    expect(source).not.toContain("ThemeToggleCompact");
    expect(source).toContain(
      '<ShellActionSurface variant="icon" aria-label="Account actions">',
    );
    expect(source).toContain('variant="destructive"');
    expect(source).toContain(
      'className="overflow-hidden rounded-[14px] p-1"',
    );
    expect(signOutItemSource).toContain("cursor-pointer");
    expect(signOutItemSource).toContain("rounded-[10px]");
    expect(signOutItemSource).toContain(
      "hover:!bg-[color:var(--app-accent)]",
    );
    expect(signOutItemSource).toContain(
      "hover:!text-[color:var(--app-accent-fg)]",
    );
    expect(signOutItemSource).toContain(
      "hover:[&_svg]:!stroke-[color:var(--app-accent-fg)]",
    );
    expect(deleteItemSource).toContain("cursor-pointer");
    expect(deleteItemSource).toContain("rounded-[10px]");
    expect(deleteItemSource).toContain(
      "hover:!bg-[color:var(--app-destructive)]",
    );
    expect(deleteItemSource).toContain(
      "hover:!text-[color:var(--app-destructive-fg)]",
    );
    expect(deleteItemSource).toContain(
      "hover:[&_svg]:!stroke-[color:var(--app-destructive-fg)]",
    );
    expect(deleteItemSource).toContain(
      "hover:[&_svg]:!text-[color:var(--app-destructive-fg)]",
    );
    expect(deleteItemSource).not.toContain(
      "data-[variant=destructive]:focus:bg-popover",
    );
    expect(signOutItemSource).toContain("focus-visible:ring-inset");
    expect(deleteItemSource).toContain("focus-visible:ring-inset");
    expect(source).not.toContain(
      'className="text-red-600 focus:text-red-600"',
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
    expect(back).toContain("navigate: (action: TopShellBackAction) => void;");
    expect(back).toContain("params.navigate(action);");
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

  it("uses shared mobile-width chrome for top-shell dropdowns", () => {
    const chrome = read("components/app-ui/top-shell-dropdown.tsx");
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

  // The shared top bar watches the whole app scroll root for DOM mutations so
  // it can find a late-mounting or swapped primary page header. That watcher
  // sits on the critical path of every animating surface: One Location keeps a
  // live map whose marker glide and Google's own tile updates mutate the DOM
  // every frame. When the watcher re-measured on each of those mutations, the
  // main thread stayed saturated with forced reflows and a tap on the back
  // arrow could not be serviced promptly.
  describe("mutation watcher stays off the animation hot path", () => {
    const source = read("components/app-ui/top-app-bar.tsx");
    const watcher = source.slice(
      source.indexOf("const scheduleHeaderRefresh"),
      source.indexOf("const retryFindHeader"),
    );

    it("re-queries only when the known header actually went away", () => {
      // A still-connected header cannot have been swapped, so the steady state
      // must not pay for a document-wide lookup.
      expect(watcher).toContain("if (!header?.isConnected)");
    });

    it("never runs the full measure-and-write pass straight off a mutation", () => {
      // `refreshHeader()` re-queries AND calls updateHeaderVisibility(), which
      // forces layout and writes custom properties on <html>. It belongs to the
      // scroll/attach paths, never to the per-mutation path.
      expect(watcher).not.toContain("refreshHeader()");
    });

    it("rate-limits re-measurement when the header did not change", () => {
      // Content can still reflow the header out of view with no scroll, so this
      // must keep tracking — just never once per animation frame.
      expect(source).toContain("const MUTATION_RECHECK_MS = 250;");
      expect(watcher).toContain("const previous = header;");
      expect(watcher).toContain(
        "if (header === previous && now - lastMutationCheckAt < MUTATION_RECHECK_MS)",
      );
      expect(watcher).toContain("lastMutationCheckAt = now;");
    });

    it("keeps re-querying unbounded so a closing flow restores header tracking", () => {
      // TaskFlowHeader does not mark itself primary, so `header` is null for the
      // whole life of a `?action=` flow. Giving up on a retry budget here would
      // strand the hub with stale tracking when the flow closes.
      expect(watcher).not.toContain("MAX_HEADER_RETRIES");
      expect(watcher).not.toContain("disconnect()");
    });
  });

  // `--top-chrome-collapse-px` feeds `--top-shell-live-height` and
  // `--top-shell-mask-solid-height`, which route content consumes for layout.
  // Writing it invalidates layout for the whole document, so an unchanged value
  // must not be rewritten — this runs on every scroll frame.
  it("writes the top-chrome custom properties only when they change", () => {
    const source = read("components/app-ui/top-app-bar.tsx");
    const update = source.slice(
      source.indexOf("const updateHeaderVisibility"),
      source.indexOf("const detachListeners"),
    );

    // Measured on a 393px viewport: past ~0.75 progress the back control is no
    // longer the element under its own coordinates, and at full collapse the
    // row sits behind `overflow: hidden` at opacity 0. A screen whose only way
    // back is this arrow must therefore not collapse at all.
    expect(update).toContain("if (hasBackControlRef.current)");
    expect(update).toContain("topChromeProgress = 0;");

    expect(update).toContain("if (nextProgress !== lastWrittenProgress)");
    expect(update).toContain("if (nextCollapsePx !== lastWrittenCollapsePx)");
    // The bar row is measured on every call; re-querying it each time is a
    // document-wide lookup for a node that almost never changes.
    expect(update).toContain("if (!barRow?.isConnected)");
    expect(update).toContain("barRow?.getBoundingClientRect().height");
  });
});
