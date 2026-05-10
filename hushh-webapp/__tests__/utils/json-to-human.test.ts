import { describe, expect, it } from "vitest";
import { jsonToHuman } from "@/lib/utils/json-to-human";

describe("jsonToHuman - Consent Payload XSS Prevention", () => {
  it("safely escapes basic HTML tags in strings", () => {
    const result = jsonToHuman("<script>alert('xss')</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("recursively escapes malicious keys and values in deep objects", () => {
    const result = jsonToHuman({
      "app_name": "Safe App",
      "<img src=x onerror=alert(1)>": {
        "description": "Steal data <svg onload=alert(2)>"
      }
    });
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
    expect(result).not.toContain("<svg");
    expect(result).toContain("&lt;svg");
  });

  it("handles safe native types normally without mutation", () => {
    expect(jsonToHuman(42)).toBe("42");
    expect(jsonToHuman(true)).toBe("true");
    expect(jsonToHuman(null)).toBe("None");
    expect(jsonToHuman(["apple", "banana"])).toBe("apple, banana");
  });

  it("handles empty objects and arrays gracefully", () => {
    expect(jsonToHuman({})).toBe("Empty data");
    expect(jsonToHuman([])).toBe("Empty list");
  });
});
