import index from "@/contracts/kai/one-route-orchestration-index.v1.json";
import { describe, expect, it } from "vitest";

describe("One route orchestration index", () => {
  it("covers each physical route exactly once with bounded metadata", () => {
    expect(index.schema_version).toBe("one.route_orchestration_index.v1");
    expect(index.routes.length).toBeGreaterThan(0);
    expect(new Set(index.routes.map((entry) => entry.route_pattern)).size).toBe(index.routes.length);
    expect(index.routes.every((entry) => entry.instruction_id && entry.context_policy)).toBe(true);
  });

  it("keeps generic sign-in off Login while retaining explicit provider actions", () => {
    const login = index.routes.find((entry) => entry.route_pattern === "/login");
    expect(login?.action_ids).toEqual(["auth.sign_in_apple", "auth.sign_in_google"]);
  });

  it("admits Location delegation only from its declared route", () => {
    const location = index.routes.find((entry) => entry.route_pattern === "/one/location");
    const profile = index.routes.find((entry) => entry.route_pattern === "/profile");
    expect(location?.delegation_policy).toEqual({
      mode: "one_action_gate",
      allowed_delegate_agent_ids: ["agent_location"],
    });
    expect(profile?.delegation_policy.mode).toBe("no_delegation");
  });
});
