import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const contractPath = resolve(process.cwd(), "app/login/page.voice-action-contract.json");
const welcomeContractPath = resolve(process.cwd(), "app/getting-started/page.voice-action-contract.json");

describe("One Voice Login onboarding contracts", () => {
  it("exposes provider-specific redirect actions only on Login", () => {
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const actions = new Map(contract.actions.map((action: { action_id: string }) => [action.action_id, action]));

    expect([...actions.keys()]).toEqual(["auth.sign_in_google", "auth.sign_in_apple"]);
    expect(actions.get("auth.sign_in_google")).toMatchObject({
      execution_target: { path: "local_handler", target: "auth.sign_in_google" },
      reachability: { screens: ["login"] },
      external_callback: {
        provider: "google",
        starts: "external_redirect_started",
        settlement: "firebase_redirect_callback",
        failure_behavior: "retain_goal_and_retry",
        return_to: "/one/setup",
      },
    });
    expect(actions.get("auth.sign_in_apple")).toMatchObject({
      execution_target: { path: "local_handler", target: "auth.sign_in_apple" },
      reachability: { screens: ["login"] },
      external_callback: {
        provider: "apple",
        starts: "external_redirect_started",
        settlement: "firebase_redirect_callback",
        failure_behavior: "retain_goal_and_retry",
        return_to: "/one/setup",
      },
    });
  });

  it("keeps generic sign-in as navigation rather than a Login provider action", () => {
    const contract = JSON.parse(readFileSync(welcomeContractPath, "utf8"));
    const generic = contract.actions.find(
      (action: { action_id: string }) => action.action_id === "auth.sign_in_open"
    );

    expect(generic.reachability.screens).not.toContain("login");
  });
});
