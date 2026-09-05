import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const contractPath = resolve(
  process.cwd(),
  "app/login/page.voice-action-contract.json",
);
const welcomeContractPath = resolve(
  process.cwd(),
  "app/getting-started/page.voice-action-contract.json",
);
const introContractPath = resolve(
  process.cwd(),
  "app/page.voice-action-contract.json",
);

describe("One Voice Login onboarding contracts", () => {
  it("exposes every visible Login action through a generated local contract", () => {
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const actions = new Map(
      contract.actions.map((action: { action_id: string }) => [
        action.action_id,
        action,
      ]),
    );

    expect([...actions.keys()]).toEqual([
      "auth.sign_in_google",
      "auth.sign_in_apple",
      // Enterprise / government IdPs are declared statically (the registry is
      // static); only the ones enabled for the environment are ever mounted.
      "auth.sign_in_sso_microsoft",
      "auth.sign_in_sso_okta",
      "auth.sign_in_sso_google_workspace",
      "auth.sign_in_sso_ping",
      "auth.sign_in_sso_onelogin",
      "auth.sign_in_sso_duo",
      "auth.sign_in_sso_salesforce",
      "auth.sign_in_sso_amazon",
      "auth.sign_in_sso_login_gov",
      "auth.sign_in_sso_idme",
      "auth.open_terms",
      "auth.open_privacy",
      "auth.close_legal",
      "onboarding.back_to_intro",
    ]);
    expect(actions.get("auth.sign_in_google")).toMatchObject({
      activation_policy: "trusted_activation_required",
      execution_target: {
        path: "local_handler",
        target: "auth.sign_in_google",
      },
      reachability: { screens: ["login"] },
    });
    expect(actions.get("auth.sign_in_apple")).toMatchObject({
      activation_policy: "trusted_activation_required",
      execution_target: { path: "local_handler", target: "auth.sign_in_apple" },
      reachability: { screens: ["login"] },
    });
    expect(actions.get("auth.open_terms")).toMatchObject({
      execution_target: { path: "local_handler", target: "auth.open_terms" },
      reachability: { screens: ["login"] },
      control_ids: ["auth_terms"],
    });
    expect(actions.get("auth.open_privacy")).toMatchObject({
      execution_target: { path: "local_handler", target: "auth.open_privacy" },
      reachability: { screens: ["login"] },
      control_ids: ["auth_privacy"],
    });
    expect(actions.get("auth.close_legal")).toMatchObject({
      execution_target: { path: "local_handler", target: "auth.close_legal" },
      reachability: { screens: ["login"] },
      control_ids: ["auth_close_legal"],
    });
    expect(actions.get("onboarding.back_to_intro")).toMatchObject({
      execution_target: {
        path: "local_handler",
        target: "onboarding.back_to_intro",
      },
      reachability: { routes: ["/login"], screens: ["login"] },
      control_ids: ["auth_back"],
    });
  });

  it("keeps generic sign-in as navigation rather than a Login provider action", () => {
    const contract = JSON.parse(readFileSync(welcomeContractPath, "utf8"));
    const generic = contract.actions.find(
      (action: { action_id: string }) =>
        action.action_id === "auth.sign_in_open",
    );

    expect(generic.reachability.screens).not.toContain("login");
  });

  it("exposes the visible root claim control as a root-only local action", () => {
    const contract = JSON.parse(readFileSync(introContractPath, "utf8"));
    const claim = contract.actions.find(
      (action: { action_id: string }) =>
        action.action_id === "onboarding.claim_one",
    );

    expect(claim).toMatchObject({
      label: "Claim your One",
      aliases: expect.arrayContaining([
        "claim your one",
        "claim my one",
        "get started",
      ]),
      reachability: { routes: ["/"], screens: ["one_intro"] },
      execution_target: {
        path: "local_handler",
        target: "onboarding.claim_one",
      },
      control_ids: ["onboarding_claim_one"],
      goal: {
        goal_id: "goal.onboarding.claim_one",
        workflow_steps: [
          expect.objectContaining({
            type: "action",
            action_id: "onboarding.claim_one",
            settlement_target: { route: "/login", screen: "login" },
          }),
          expect.objectContaining({
            type: "choice",
            action_ids: ["auth.sign_in_google", "auth.sign_in_apple"],
            carry_explicit_choice: true,
          }),
        ],
      },
    });
  });
});
