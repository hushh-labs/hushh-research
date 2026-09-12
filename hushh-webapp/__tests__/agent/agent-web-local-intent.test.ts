import { expect, it } from "vitest";
import { HushhAgentWeb } from "@/lib/capacitor/plugins/agent-web";

it("retires local phrase selection without proposing or executing an action", async () => {
  const adapter = new HushhAgentWeb();
  const response = await adapter.handleMessage();
  expect(response.intent).toBeUndefined();
  expect(response.response).toBe("__USE_REMOTE_API__");
  await expect(adapter.classifyIntent()).rejects.toThrow("retired");
});
