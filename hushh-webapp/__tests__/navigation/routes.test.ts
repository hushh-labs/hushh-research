import { describe, expect, it } from "vitest";

import {
  buildRiaClientAccountRoute,
  buildRiaClientRequestRoute,
  buildRiaClientWorkspaceRoute,
} from "@/lib/navigation/routes";

describe("navigation routes", () => {
  it("preserves query parameter integrity for ria workspace tabs", () => {
    expect(buildRiaClientWorkspaceRoute("client-123", { tab: "kai" })).toBe(
      "/ria/clients/client-123?tab=kai"
    );

    expect(buildRiaClientWorkspaceRoute("client 123", { tab: "access" })).toBe(
      "/ria/clients/client%20123?tab=access"
    );
  });

  it("preserves encoded route segments for ria account and request routes", () => {
    expect(buildRiaClientAccountRoute("client 123", "acct 456")).toBe(
      "/ria/clients/client%20123/accounts/acct%20456"
    );

    expect(buildRiaClientRequestRoute("client 123", "request 789")).toBe(
      "/ria/clients/client%20123/requests/request%20789"
    );
  });
});