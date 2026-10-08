import type { TopShellBackAction } from "@/lib/navigation/top-shell-back";

export type BackVerification = {
  kind: "parent" | "root" | "redirect" | "surface-owned";
  reason?: string;
  sourceRevision?: string;
  cases: { href: string; expected: TopShellBackAction | null }[];
};
type Entry = { route: string; backVerification?: BackVerification };
type Resolver = (href: string) => TopShellBackAction | null;

function internal(href: string): URL {
  if (!href.startsWith("/") || href.startsWith("//") || /[\\\r\n]/.test(href)) throw new Error(`Unsafe Back href: ${href}`);
  return new URL(href, "https://app.test");
}
function matches(pattern: string, pathname: string): boolean {
  const parts = pattern.split("?")[0].split("/");
  const actual = pathname.split("/");
  return parts.length === actual.length && parts.every((part, i) => part === actual[i] || /^\[[^\]]+\]$/.test(part));
}

/** Verification only: the existing runtime resolver remains the sole parent authority. */
export function validateBackContracts(entries: readonly Entry[], resolve: Resolver): void {
  for (const entry of entries) {
    const verification = entry.backVerification;
    if (!verification?.cases?.length || !["parent", "root", "redirect", "surface-owned"].includes(verification.kind)) throw new Error(`Missing Back coverage: ${entry.route}`);
    if (verification.kind !== "parent" && !verification.reason?.trim()) throw new Error(`Unexplained Back boundary: ${entry.route}`);
    for (const scenario of verification.cases) {
      const start = internal(scenario.href);
      if (!matches(entry.route, start.pathname)) throw new Error(`Wrong Back sample: ${scenario.href}`);
      const actual = resolve(scenario.href);
      if (JSON.stringify(actual) !== JSON.stringify(scenario.expected)) throw new Error(`Back drift: ${scenario.href}; expected ${JSON.stringify(scenario.expected)}, got ${JSON.stringify(actual)}`);
      let href = scenario.href;
      const seen = new Set<string>();
      for (let depth = 0; ; depth++) {
        const current = internal(href);
        current.searchParams.sort();
        const key = current.pathname + "?" + current.searchParams.toString();
        if (seen.has(key) || depth > entries.length * 2) throw new Error(`Back cycle: ${scenario.href} -> ${href}`);
        seen.add(key);
        const parent = resolve(href);
        if (!parent) {
          const terminal = entries.find(candidate => matches(candidate.route, current.pathname))?.backVerification;
          if (!terminal || terminal.kind === "parent") throw new Error(`Unclassified Back root: ${href}`);
          break;
        }
        const target = internal(parent.href);
        if (!entries.some(candidate => matches(candidate.route, target.pathname))) throw new Error(`Orphan Back parent: ${parent.href}`);
        if (target.pathname === current.pathname && (parent.mode !== "replace" || parent.transitionMode !== "contextual")) throw new Error(`Query Back must replace contextually: ${href}`);
        href = parent.href;
      }
    }
  }
}
