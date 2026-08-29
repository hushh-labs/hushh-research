import { describe, expect, it } from "vitest";

import {
  parseAgentActivityExperience,
  parseAgentToolResultExperience,
} from "@/lib/agent/agui-structured-experiences";

const scopeResult = {
  status: "ok",
  person: {
    displayName: "Alex Morgan",
    personRef: "not-for-display",
    profilePath: "/people/1234567890abcdef",
    relationship: "connected",
  },
  domainFilter: "Identity",
  requestableScopes: [
    {
      scopeRef: "opaque-scope-ref",
      label: "Employment status",
      description: "Current employment eligibility status.",
      domain: "Identity",
      sensitivity: "high",
    },
  ],
};

describe("AG-UI structured experience registry", () => {
  it("accepts the versioned scope activity and normalizes its bounded fields", () => {
    expect(
      parseAgentActivityExperience("one.scope_discovery.v1", scopeResult),
    ).toEqual({
      type: "one.scope_discovery.v1",
      person: {
        displayName: "Alex Morgan",
        profilePath: "/people/1234567890abcdef",
        relationship: "connected",
      },
      domainFilter: "Identity",
      scopes: [
        {
          scopeRef: "opaque-scope-ref",
          label: "Employment status",
          description: "Current employment eligibility status.",
          domain: "Identity",
          sensitivity: "restricted",
        },
      ],
    });
  });

  it("adapts the existing ADK tool result into the same app-owned registry", () => {
    expect(
      parseAgentToolResultExperience(
        "discover_person_information",
        JSON.stringify(scopeResult),
      ),
    ).toMatchObject({ type: "one.scope_discovery.v1" });
  });

  it("fails closed for unknown types, invalid routes, and unrelated tools", () => {
    expect(parseAgentActivityExperience("model.react.v1", scopeResult)).toBeNull();
    expect(
      parseAgentToolResultExperience("unknown_tool", scopeResult),
    ).toBeNull();
    expect(
      parseAgentToolResultExperience("discover_person_information", {
        ...scopeResult,
        person: { ...scopeResult.person, profilePath: "https://attacker.example" },
      }),
    ).toBeNull();
  });
});
