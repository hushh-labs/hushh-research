import { describe, it, expect } from "vitest";

import { safeParseResponse }
from "../../../../app/api/consent/cancel/response-parser";
describe("safeParseResponse", () => {

  it("preserves valid json responses", async () => {

    const response = new Response(
      JSON.stringify({
        success: true
      }),
      {
        headers: {
          "content-type":
          "application/json"
        }
      }
    );

    expect(
      await safeParseResponse(
        response
      )
    ).toEqual({
      success: true
    });

  });

  it("handles text responses safely", async () => {

    const response = new Response(
      "backend unavailable",
      {
        headers: {
          "content-type":
          "text/plain"
        }
      }
    );

    expect(
      await safeParseResponse(
        response
      )
    ).toEqual({
      upstreamError:
      "backend unavailable"
    });

  });

  it("handles empty responses", async () => {

    expect(
      await safeParseResponse(
        new Response("")
      )
    ).toEqual({});

  });

});