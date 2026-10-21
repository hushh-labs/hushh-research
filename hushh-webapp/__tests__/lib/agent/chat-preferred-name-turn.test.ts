import { describe, expect, it, vi } from "vitest";
import { beginChatPreferredNameTurn } from "@/lib/agent/chat-preferred-name-turn";

const result = (name = "Ruby") => ({ status: "preferred_name_update_ready", preferred_name: name });

describe("live preferred-name commitment", () => {
  it("writes once only after a successful turn, preserving the chosen Unicode name", async () => {
    const save = vi.fn().mockResolvedValue(true);
    const turn = beginChatPreferredNameTurn({ isCurrent: () => true, save });
    turn.stage(JSON.stringify(result("李 小龍")), "call-1");
    turn.stage(result("李 小龍"), "call-1"); // Exact transport redelivery.
    expect(save).not.toHaveBeenCalled();
    expect(await turn.finish(true)).toBe(true);
    expect(await turn.finish(true)).toBeNull();
    expect(save).toHaveBeenCalledExactlyOnceWith("李 小龍", expect.any(Function), expect.any(Function));
  });

  it.each(["cancelled", "stale", "conflicting", "malformed", "offer"])("does not write a %s turn", async (mode) => {
    let current = true;
    const save = vi.fn();
    const turn = beginChatPreferredNameTurn({ isCurrent: () => current, save });
    turn.stage(mode === "malformed" ? result("A".repeat(65)) :
      mode === "offer" ? { status: "offer_ready", proposed: { preferred_name: "Ruby" } } : result(), "call-1");
    if (mode === "conflicting") turn.stage(result("Rootman"), "call-2");
    if (mode === "stale") current = false;
    expect(await turn.finish(mode !== "cancelled")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("rechecks authority at the write boundary and suppresses late success", async () => {
    let current = true;
    const save = vi.fn(async (_name, beforeEffect) => {
      current = false;
      await expect(beforeEffect()).rejects.toMatchObject({ name: "AbortError" });
      return true;
    });
    const turn = beginChatPreferredNameTurn({ isCurrent: () => current, save });
    turn.stage(result(), "call-1");
    expect(await turn.finish(true)).toBeNull();
  });

  it.each([false, "reject"])("reports an unsuccessful encrypted save without a saved acknowledgement (%s)", async (outcome) => {
    const save = outcome === "reject" ? vi.fn().mockRejectedValue(new Error("offline")) : vi.fn().mockResolvedValue(false);
    const turn = beginChatPreferredNameTurn({ isCurrent: () => true, save });
    turn.stage(result(), "call-1");
    expect(await turn.finish(true)).toBe(false);
  });
});
