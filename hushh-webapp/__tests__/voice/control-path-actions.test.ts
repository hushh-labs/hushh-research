import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * #6122: location.find_contacts and ria.clients.switch_to_nearby are wired
 * in the contract with execution_target.path: "control" -- a UI control the
 * person taps directly, not a route or a local_handler-named function. That
 * path value was missing from validateExecutionTarget's accepted union, so
 * validateAction dropped both actions entirely: getKaiActionById returned
 * null for either id, for every consumer, with no error anywhere.
 */
describe("execution_target.path: \"control\" actions are no longer silently dropped", () => {
  it("location.find_contacts resolves and is wired", () => {
    const action = getKaiActionById("location.find_contacts");
    expect(action).not.toBeNull();
    expect(action?.execution_target.status).toBe("wired");
    expect(action?.execution_target.path).toBe("control");
  });

  it("ria.clients.switch_to_nearby resolves and is wired", () => {
    const action = getKaiActionById("ria.clients.switch_to_nearby");
    expect(action).not.toBeNull();
    expect(action?.execution_target.status).toBe("wired");
    expect(action?.execution_target.path).toBe("control");
  });
});
