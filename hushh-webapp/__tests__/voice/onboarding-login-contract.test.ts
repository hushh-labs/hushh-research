import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const contractPath = resolve(process.cwd(), "app/login/page.voice-action-contract.json");
const welcomeContractPath = resolve(process.cwd(), "app/getting-started/page.voice-action-contract.json");
const introContractPath = resolve(process.cwd(), "app/page.voice-action-contract.json");

describe("One Voice Login onboarding contracts", () => {
  it("exposes provider-specific popup actions only on Login", () => {
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const actions = new Map(contract.actions.map((action: { action_id: string }) => [action.action_id, action]));

    expect([...actions.keys()]).toEqual(["auth.sign_in_google", "auth.sign_in_apple"]);
    expect(actions.get("auth.sign_in_google")).toMatchObject({
      execution_target: { path: "local_handler", target: "auth.sign_in_google" },
      reachability: { screens: ["login"] },
    });
    expect(actions.get("auth.sign_in_apple")).toMatchObject({
      execution_target: { path: "local_handler", target: "auth.sign_in_apple" },
      reachability: { screens: ["login"] },
    });
  });

  it("keeps generic sign-in as navigation rather than a Login provider action", () => {
    const contract = JSON.parse(readFileSync(welcomeContractPath, "utf8"));
    const generic = contract.actions.find(
      (action: { action_id: string }) => action.action_id === "auth.sign_in_open"
    );

    expect(generic.reachability.screens).not.toContain("login");
  });

  it("exposes the visible root claim control as a root-only local action", () => {
    const contract = JSON.parse(readFileSync(introContractPath, "utf8"));
    const claim = contract.actions.find(
      (action: { action_id: string }) => action.action_id === "onboarding.claim_one"
    );

    expect(claim).toMatchObject({
      label: "Claim your One",
      aliases: expect.arrayContaining(["claim your one", "claim my one", "get started"]),
      reachability: { routes: ["/"], screens: ["one_intro"] },
      execution_target: { path: "local_handler", target: "onboarding.claim_one" },
      control_ids: ["onboarding_claim_one"],
    });
  });
});
