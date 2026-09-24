import { describe, expect, it } from "vitest";
import { parsePickedDriveFiles } from "@/lib/services/google-drive-picker-service";

describe("untrusted Picker selection", () => {
  it("keeps names as data and drops URLs/provider metadata", () => {
    expect(
      parsePickedDriveFiles([
        {
          id: "file_123",
          name: "<script>do bad things</script>",
          url: "https://attacker.invalid",
          accessToken: "never retain",
        },
      ]),
    ).toEqual([{ id: "file_123", name: "<script>do bad things</script>" }]);
  });
  it.each(
    [
      [],
      [{ id: "../escape", name: "a" }],
      [{ id: "https://attacker.invalid", name: "a" }],
      [{ id: "a", name: 42 }],
      [
        { id: "a", name: "a" },
        { id: "a", name: "b" },
      ],
      Array.from({ length: 26 }, (_, i) => ({ id: `file${i}`, name: "a" })),
    ].map((value) => [value]),
  )("rejects invalid or oversized candidates", (value) => {
    expect(() => parsePickedDriveFiles(value)).toThrow();
  });
});
