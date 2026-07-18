import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mockApiFetch,
  },
}));

import {
  DeveloperPortalRequestError,
  getLiveDeveloperDocs,
} from "@/lib/services/developer-portal-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("developer-portal-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("DeveloperPortalRequestError", () => {
    it("stores status and code metadata", () => {
      const error = new DeveloperPortalRequestError(
        "Access denied",
        {
          status: 403,
          code: "access_denied",
        }
      );

      expect(error.name).toBe("DeveloperPortalRequestError");
      expect(error.message).toBe("Access denied");
      expect(error.status).toBe(403);
      expect(error.code).toBe("access_denied");
    });
  });

  describe("getLiveDeveloperDocs", () => {
    it("combines scopes and tools responses", async () => {
      mockApiFetch
        .mockResolvedValueOnce(
          jsonResponse({
            scopes: [
              {
                name: "vault",
                description: "Vault scope",
              },
            ],
            notes: ["scope-note"],
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            tools: [
              {
                name: "search",
                description: "Search tool",
              },
            ],
            notes: ["tool-note"],
          })
        );

      const result = await getLiveDeveloperDocs();

      expect(result.scopes).toEqual([
        {
          name: "vault",
          description: "Vault scope",
        },
      ]);

      expect(result.tools).toEqual([
        {
          name: "search",
          description: "Search tool",
        },
      ]);

      expect(result.notes).toEqual([
        "scope-note",
        "tool-note",
      ]);
    });

    it("throws when both endpoints are unavailable", async () => {
      mockApiFetch
        .mockRejectedValueOnce(new Error("scope unavailable"))
        .mockRejectedValueOnce(new Error("tool unavailable"));

      await expect(
        getLiveDeveloperDocs()
      ).rejects.toThrow(
        "Live developer contract is unavailable right now."
      );
    });
  });
});
