import { describe, expect, it } from "vitest";
import entries from "@/lib/navigation/app-route-layout.contract.json";
import { resolveTopShellBackAction } from "@/lib/navigation/top-shell-back";
import { validateBackContracts, type BackVerification } from "@/scripts/architecture/back-contract-validation";

const contracts = entries as unknown as { route: string; backVerification: BackVerification }[];
const resolve = (href: string) => {
  const url = new URL(href, "https://app.test");
  return resolveTopShellBackAction({ pathname: url.pathname, searchParams: url.searchParams, sectionOrigin: null });
};
describe("authored Back hierarchy", () => {
  it("covers every route and query scenario with safe, acyclic production parents", () => {
    validateBackContracts(contracts, resolve);
  });
  it("rejects missing coverage, wrong parents, cycles and unsafe targets", () => {
    expect(() => validateBackContracts([{ route: "/new-screen" }], resolve)).toThrow(/Missing Back coverage/);
    const changed = structuredClone(contracts);
    changed.find(entry => entry.route === "/one/pkm")!.backVerification.cases[0].expected!.href = "/one/location";
    expect(() => validateBackContracts(changed, resolve)).toThrow(/Back drift/);
    const root = { route: "/", backVerification: { kind: "root" as const, reason: "Application root", cases: [{ href: "/", expected: null }] } };
    const cycle = { route: "/a", backVerification: { kind: "parent" as const, cases: [{ href: "/a", expected: { href: "/a", mode: "replace" as const, transitionMode: "contextual" as const } }] } };
    expect(() => validateBackContracts([root, cycle], href => href === "/a" ? cycle.backVerification.cases[0].expected : null)).toThrow(/Back cycle/);
    cycle.backVerification.cases[0].expected.href = "//evil.test";
    expect(() => validateBackContracts([root, cycle], href => href === "/a" ? cycle.backVerification.cases[0].expected : null)).toThrow(/Unsafe Back href/);
  });
});
