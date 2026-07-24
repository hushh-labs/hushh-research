import { getNestedValue, hasNestedKey } from "@/lib/utils/object";

describe("object utils", () => {
  const payload = {
    response: {
      metadata: {
        response_id: "resp_123",
      },
    },
    empty: null,
    count: 0,
  };

  it("reads nested values from valid objects", () => {
    expect(getNestedValue(payload, "response.metadata.response_id")).toBe("resp_123");
    expect(getNestedValue(payload, "count")).toBe(0);
  });

  it("returns the fallback for missing or null paths", () => {
    expect(getNestedValue(payload, "response.metadata.missing", "fallback")).toBe("fallback");
    expect(getNestedValue(payload, "empty.value", "fallback")).toBe("fallback");
    expect(getNestedValue(null, "response.id", "fallback")).toBe("fallback");
  });

  it("checks nested key presence without throwing on primitives", () => {
    expect(hasNestedKey(payload, "response.metadata.response_id")).toBe(true);
    expect(hasNestedKey({ response: "done" }, "response.metadata.response_id")).toBe(false);
    expect(hasNestedKey(undefined, "response.id")).toBe(false);
  });
});
