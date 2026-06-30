import { describe, expect, it } from "vitest";

import { KAI_COMMAND_BAR_OPEN_EVENT } from "@/lib/navigation/kai-command-bar-events";

describe("kai-command-bar-events", () => {
  it("preserves the kai command bar open event name", () => {
    expect(KAI_COMMAND_BAR_OPEN_EVENT).toBe("kai:command-bar:open");
  });
});