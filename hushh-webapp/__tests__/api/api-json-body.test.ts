import { NextRequest } from "next/server";

import { readJsonObject } from "@/app/api/_utils/json-body";

describe("readJsonObject", () => {
  it("rejects array payloads as invalid JSON objects", async () => {
    const request = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ id: "item-1" }]),
    });

    await expect(readJsonObject(request)).resolves.toBeNull();
  });
});
