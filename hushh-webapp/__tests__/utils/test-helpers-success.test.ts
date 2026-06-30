import { describe, expect, it } from "vitest";

import { expectSuccess } from "./test-helpers";

describe("expectSuccess", () => {
  it("returns json for successful responses", async () => {
    const response = Response.json({ ok: true }, { status: 200 });

    await expect(expectSuccess(response)).resolves.toEqual({ ok: true });
  });
});