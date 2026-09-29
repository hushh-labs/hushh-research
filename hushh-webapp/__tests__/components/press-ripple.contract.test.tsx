/**
 * Press contract: a press is FLAT (colour or opacity plus the ripple), never a
 * scale, spring, or bounce, and the ripple is on by default everywhere a
 * person taps, agent chat included.
 *
 * Founder report (2026-09-28): the sign-in buttons ("Create your One", Apple,
 * Google) bounced on press, and agent chat buttons showed no ripple. Root
 * causes this file pins:
 *  - the bounce came from `press-scale` / `active:scale-*` on the core Button
 *    primitives and from the `.press-scale` utility's `transform: scale()`;
 *  - chat buttons were the stock `components/ui/button` (no ripple at all) or
 *    plain `<button>` elements (no ripple, no positioned box), and the
 *    composer's Send painted an accent ripple on an accent fill, which is
 *    invisible.
 *
 * Real pointerdown-to-ripple behaviour in Chromium and WebKit is covered by
 * e2e/press-ripple.layout.spec.ts; jsdom has no Web Animations, so this file
 * pins structure, wiring, and the reduced-motion fallback.
 */
import fs from "node:fs";
import path from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AgentFollowUpSuggestions } from "@/components/agent/agent-follow-up-suggestions";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import { IntroStep } from "@/components/onboarding/IntroStep";
import { Button as StockButton } from "@/components/ui/button";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";

vi.mock("@/components/onboarding/OnboardingHeroBackground", () => ({
  OnboardingHeroBackground: () => null,
}));
vi.mock("@/lib/morphy-ux/gsap", () => ({
  getGsap: vi.fn(async () => null),
}));

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// Scanners. Each one is exercised against a known-bad snippet below so a
// scanner that silently matches nothing cannot pass the suite.
// ---------------------------------------------------------------------------

/**
 * Tailwind press scale (any variant chain ending in `active:scale-*`) and
 * motion-library tap/spring physics. Hover zooms on avatars and tiles are not
 * presses; a hover scale on a button is caught by the rendered checks below.
 */
const BOUNCE_CLASS =
  /(?:^|[\s"'`])(?:[\w-]+:)*(?:group-|peer-)?active:scale-(?:\[[^\]]+\]|[\w.]+)|\bwhileTap\b|type:\s*["']spring["']/;

function findBounceClasses(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => BOUNCE_CLASS.test(line))
    .map((line) => line.trim());
}

/** Any CSS `:active` rule, or the press utility, that sets a transform. */
function findActiveTransforms(css: string): string[] {
  const hits: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(rule)) {
    const selector = match[1].trim();
    const body = match[2];
    const isPressRule =
      /:active\b/.test(selector) || /\.press-scale\b/.test(selector);
    if (isPressRule && /\btransform\s*:(?!\s*none\b)/.test(body)) {
      hits.push(selector);
    }
  }
  return hits;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listSourceFiles(rel));
    } else if (
      /\.(tsx?|css)$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    ) {
      out.push(rel);
    }
  }
  return out;
}

const RIPPLE_HOST = ":scope > .morphy-ripple-host";

function rippleHosts(element: Element) {
  return element.querySelectorAll(RIPPLE_HOST);
}

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeAll(() => {
  // jsdom cannot run Material Web's Lit element; a stub with the same
  // attach contract proves the wiring (see material-ripple.test.tsx).
  if (!customElements.get("md-ripple")) {
    customElements.define(
      "md-ripple",
      class extends HTMLElement {
        attachedTo: HTMLElement | null = null;
        disabled = false;
        attach(control: HTMLElement) {
          this.attachedTo = control;
        }
        detach() {
          this.attachedTo = null;
        }
      },
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("scanners (negative controls)", () => {
  it("flag a press scale and spring physics, not a resting scale", () => {
    expect(
      findBounceClasses(
        [
          'className="press-scale active:scale-[0.97]"',
          'className="motion-reduce:active:scale-100 rounded-full"',
          "cn('group-active:scale-95')",
          "<motion.button whileTap={{ scale: 0.9 }} />",
          "transition={{ type: 'spring' }}",
        ].join("\n"),
      ),
    ).toHaveLength(5);
    expect(findBounceClasses('className="scale-100 rotate-180"')).toEqual([]);
  });

  it("flag an :active or press-utility transform, and allow flat ones", () => {
    expect(
      findActiveTransforms(
        ".a:active { transform: scale(0.97); }\n.press-scale:active:not(:disabled) { transform: scale(var(--x)); }",
      ),
    ).toEqual([".a:active", ".press-scale:active:not(:disabled)"]);
    expect(
      findActiveTransforms(
        ".a:active { opacity: 0.8; }\n.press-scale { transform: none; }",
      ),
    ).toEqual([]);
  });
});

describe("no bounce", () => {
  it("keeps press scale and springs out of every app source", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap(listSourceFiles)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
      .flatMap((file) =>
        findBounceClasses(read(file)).map((line) => `${file}: ${line}`),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps every :active rule and the press utility transform-free", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap(listSourceFiles)
      .filter((file) => file.endsWith(".css"))
      .flatMap((file) =>
        findActiveTransforms(read(file)).map((sel) => `${file}: ${sel}`),
      );
    expect(offenders).toEqual([]);
  });

  it("renders both core Buttons without a press-scale or scale class", () => {
    render(
      <>
        <StockButton>Stock</StockButton>
        <MorphyButton>Morphy</MorphyButton>
      </>,
    );
    for (const name of ["Stock", "Morphy"]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).not.toMatch(/press-scale|scale-|transform/);
    }
  });
});

describe("ripple on by default", () => {
  it("gives the stock Button one ripple, attached to the button itself", async () => {
    render(<StockButton>Continue</StockButton>);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(rippleHosts(button)).toHaveLength(1);
    expect(button.className).toMatch(/(^|\s)relative(\s|$)/);
    await waitFor(() => {
      const ripple = button.querySelector("md-ripple") as
        | (HTMLElement & { attachedTo: HTMLElement | null })
        | null;
      expect(ripple?.attachedTo).toBe(button);
    });
  });

  it("paints no second layer when a caller owns the ripple", () => {
    render(
      <>
        <StockButton showRipple={false}>Plain</StockButton>
        <MorphyButton>Morphy</MorphyButton>
      </>,
    );
    expect(
      rippleHosts(screen.getByRole("button", { name: "Plain" })),
    ).toHaveLength(0);
    // The Morphy Button wraps the stock one; exactly one ripple, not two.
    expect(
      rippleHosts(screen.getByRole("button", { name: "Morphy" })),
    ).toHaveLength(1);
  });

  it("carries the ripple through asChild without breaking the single child", () => {
    render(
      <StockButton asChild>
        <a href="/one">Open One</a>
      </StockButton>,
    );
    const link = screen.getByRole("link", { name: "Open One" });
    expect(rippleHosts(link)).toHaveLength(1);
  });
});

describe("reduced motion", () => {
  it("swaps the growing ripple for an opacity-only press layer", async () => {
    stubMatchMedia(true);
    render(<StockButton>Reduced</StockButton>);
    const button = screen.getByRole("button", { name: "Reduced" });
    const host = await waitFor(() => {
      const found = button.querySelector<HTMLElement>(
        '.morphy-ripple-host[data-ripple-mode="flat"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(host.querySelector("md-ripple")).toBeNull();
    const layer = host.querySelector<HTMLElement>("[data-ripple-flat]")!;
    expect(layer.style.transform).toBe("");
    expect(layer.style.transition).toMatch(/^opacity \d+ms/);
    expect(layer.style.opacity).toBe("0");

    fireEvent.pointerDown(button, { isPrimary: true, button: 0, pointerType: "mouse" });
    expect(layer).toHaveAttribute("data-pressed", "true");
    // jsdom cannot parse var() in an inline opacity; the resolved pressed
    // opacity is asserted in a real engine by e2e/press-ripple.layout.spec.ts.
    expect(layer.style.opacity).not.toBe("0");

    fireEvent.pointerUp(button, { isPrimary: true, pointerType: "mouse" });
    expect(layer).not.toHaveAttribute("data-pressed");
    expect(layer.style.opacity).toBe("0");
  });

  it("keeps the Material ripple, not the flat layer, when motion is allowed", async () => {
    stubMatchMedia(false);
    render(<StockButton>Full</StockButton>);
    const button = screen.getByRole("button", { name: "Full" });
    await waitFor(() => {
      expect(button.querySelector("md-ripple")).not.toBeNull();
    });
    expect(button.querySelector("[data-ripple-flat]")).toBeNull();
    expect(
      button.querySelector(".morphy-ripple-host")?.getAttribute("data-ripple-mode"),
    ).toBe("material");
  });
});

describe("named buttons from the founder report", () => {
  it("renders Create your One through the primitive, flat and rippled", () => {
    render(<IntroStep onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    fireEvent.click(screen.getByRole("button", { name: "See what’s next" }));
    const cta = screen.getByRole("button", { name: "Create your One" });
    expect(rippleHosts(cta)).toHaveLength(1);
    expect(cta.className).not.toMatch(/press-scale|scale-/);
  });

  it("renders the Apple and Google buttons through the primitive, flat and rippled", () => {
    const authStep = read("components/onboarding/AuthStep.tsx");
    // Apple and Google are rendered by AuthProviderButton, not a local button.
    expect(authStep).toMatch(/authOptions\.map\(\(option\) => \(\s*<AuthProviderButton/);
    expect(findBounceClasses(authStep)).toEqual([]);
    expect(read("components/onboarding/AuthProviderButton.tsx")).toContain(
      'from "@/lib/morphy-ux/button"',
    );

    render(
      <>
        <AuthProviderButton label="Continue with Apple" icon={null} />
        <AuthProviderButton label="Continue with Google" icon={null} />
      </>,
    );
    for (const name of ["Continue with Apple", "Continue with Google"]) {
      const button = screen.getByRole("button", { name });
      expect(rippleHosts(button)).toHaveLength(1);
      expect(button.className).not.toMatch(/press-scale|scale-/);
    }
  });
});

describe("agent chat", () => {
  it("gives every follow-up chip its own positioned, clipped ripple", async () => {
    render(
      <AgentFollowUpSuggestions
        suggestions={["Show my week", "Draft a reply"]}
        onSelect={vi.fn()}
      />,
    );
    const chips = screen
      .getByTestId("agent-follow-up-suggestions")
      .querySelectorAll("button");
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      // The ripple host is absolute inset-0: without `relative` it would
      // size itself to some ancestor, and without a clip it would spill.
      expect(chip.className).toMatch(/(^|\s)relative(\s|$)/);
      expect(chip.className).toMatch(/(^|\s)overflow-hidden(\s|$)/);
      expect(rippleHosts(chip)).toHaveLength(1);
    }
    await waitFor(() => {
      const ripple = chips[0].querySelector("md-ripple") as
        | (HTMLElement & { attachedTo: HTMLElement | null })
        | null;
      expect(ripple?.attachedTo).toBe(chips[0]);
    });
  });

  it("tints the Send ripple with the label colour so it shows on the accent fill", () => {
    render(
      <>
        <ShellActionSurface type="submit" rippleEffect="fill" aria-label="Send message" />
        <ShellActionSurface aria-label="Glass control" />
      </>,
    );
    const send = screen.getByRole("button", { name: "Send message" });
    const sendHost = send.querySelector<HTMLElement>(".morphy-ripple-host")!;
    expect(sendHost.style.getPropertyValue("--md-ripple-pressed-color")).toBe(
      "currentColor",
    );
    // Negative control: the glass default is accent-coloured, which is what
    // vanished on Send's accent fill.
    const glassHost = screen
      .getByRole("button", { name: "Glass control" })
      .querySelector<HTMLElement>(".morphy-ripple-host")!;
    expect(glassHost.style.getPropertyValue("--md-ripple-pressed-color")).toBe(
      "var(--app-accent)",
    );
    expect(send.className).not.toMatch(/scale-/);

    const workspace = read("components/agent/agent-chat-workspace.tsx");
    expect(workspace).toMatch(
      /type="submit"\s+rippleEffect="fill"[\s\S]{0,400}aria-label="Send message"/,
    );
  });

  it("wires the ripple into the chat's message actions and Activity trigger", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    for (const label of [
      "Copy response",
      "Like response",
      "Dislike response",
      '"Try again"',
    ]) {
      const at = workspace.indexOf(label);
      expect(at, label).toBeGreaterThan(-1);
      const close = workspace.indexOf("</button>", at);
      expect(workspace.slice(at, close), label).toContain("<MaterialRipple");
    }
    const activity = read("components/app-ui/stream-progress-panel.tsx");
    const trigger = activity.slice(
      activity.indexOf("<CollapsibleTrigger asChild>"),
      activity.indexOf("</CollapsibleTrigger>"),
    );
    expect(trigger).toContain("<MaterialRipple");
    expect(trigger).toMatch(/className="[^"]*\brelative\b/);
  });
});
