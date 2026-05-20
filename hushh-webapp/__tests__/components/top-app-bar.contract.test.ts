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

  it("keeps persona switching scoped to Profile", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("function normalizeTopBarPathname");
    expect(source).toContain("pathname.startsWith(`${ROUTES.RIA_HOME}/`)");
    expect(source).toContain("function isProfileTopBarRoute");
    expect(source).toContain("centerTitle.interactive && canShowPersonaSwitcher");
    expect(source).toContain("function roleSwitcherLabel");
    expect(source).toContain('label: "Profile"');
    expect(source).toContain("icon: UserRound");
    expect(source).toContain(
      'pathname === ROUTES.RIA_ONBOARDING && target === "investor"',
    );
    expect(source).toContain("router.push(nextRoute);");
  });

  it("uses deterministic breadcrumb parents instead of browser history for top-bar back", () => {
    const source = read("components/app-ui/top-app-bar.tsx");

    expect(source).toContain("router.push(topShellBreadcrumb.backHref);");
    expect(source).not.toContain("router.back();");
  });

  it("uses shared mobile-width chrome for top-shell shield and bell dropdowns", () => {
    const chrome = read("components/app-ui/top-shell-dropdown.tsx");
    const consentInbox = read("components/consent/consent-inbox-dropdown.tsx");
    const taskCenter = read("components/app-ui/debate-task-center.tsx");

    expect(chrome).toContain("export function TopShellDropdownContent");
    expect(chrome).toContain("centeredMobileAlignOffset");
    expect(chrome).toContain(
      'querySelectorAll<HTMLElement>(\n      \'[data-slot="dropdown-menu-trigger"][data-state="open"]\'',
    );
    expect(chrome).toContain("max-md:w-[calc(100vw-1.5rem)]");
    expect(chrome).toContain("max-md:min-w-[calc(100vw-1.5rem)]");
    expect(chrome).toContain("max-md:max-w-[calc(100vw-1.5rem)]");
    expect(chrome).toContain("TOP_SHELL_DROPDOWN_COLLISION_PADDING = 12");
    expect(consentInbox).toContain(
      'import {\n  TOP_SHELL_DROPDOWN_BODY_CLASSNAME',
    );
    expect(consentInbox).toContain("TopShellDropdownContent");
    expect(consentInbox).toContain('<TopShellDropdownContent align="end">');
    expect(taskCenter).toContain("TopShellDropdownContent");
    expect(taskCenter).toContain('<TopShellDropdownContent align="end">');
    expect(consentInbox).not.toContain("TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME");
    expect(taskCenter).not.toContain("TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME");
  });

  it("clears every selection-driving consent detail param when the panel closes", () => {
    const source = read("components/consent/consent-center-page.tsx");

    expect(source).toContain(`onOpenChange={(open) => {
          if (!open) {
            setParam({
              requestId: null,
              selected: null,
              notificationAction: null,
            });
          }
        }}`);
  });
});
