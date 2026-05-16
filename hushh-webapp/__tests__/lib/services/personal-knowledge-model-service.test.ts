import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/config", () => ({
  auth: {},
}));

import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

describe("PersonalKnowledgeModelService error extraction", () => {
  it("extracts plain string details", () => {
    expect(
      PersonalKnowledgeModelService.extractResponseDetail(
        "PKM request failed"
      )
    ).toBe("PKM request failed");
  });

  it("extracts validation array messages", () => {
    expect(
      PersonalKnowledgeModelService.extractResponseDetail({
        detail: [
          {
            loc: ["body", "domain"],
            msg: "Field required",
          },
        ],
      })
    ).toBe("body.domain: Field required");
  });

  it("extracts nested detail message", () => {
    expect(
      PersonalKnowledgeModelService.extractResponseDetail({
        detail: {
          message: "Invalid manifest",
        },
      })
    ).toBe("Invalid manifest");
  });

  it("joins multiple validation errors", () => {
    expect(
      PersonalKnowledgeModelService.extractResponseDetail({
        detail: [
          {
            loc: ["body", "user_id"],
            msg: "Missing value",
          },
          {
            loc: ["body", "domain"],
            msg: "Invalid domain",
          },
        ],
      })
    ).toBe(
      "body.user_id: Missing value; body.domain: Invalid domain"
    );
  });

  it("returns null for unsupported payloads", () => {
    expect(
      PersonalKnowledgeModelService.extractResponseDetail(null)
    ).toBeNull();
  });
});