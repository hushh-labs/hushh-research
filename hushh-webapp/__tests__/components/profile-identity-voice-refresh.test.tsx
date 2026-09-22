import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolResultPublic } from "@/lib/one-voice/protocol";

type Effects = {
  onToolResult?: (tool: string, result: ToolResultPublic) => void;
  onPendingResolved?: (id: string, status: string, result: ToolResultPublic) => void;
};

const mocks = vi.hoisted(() => ({
  effects: {} as Effects,
  user: { uid: "uid-1", reload: vi.fn(async () => undefined) },
  invalidate: vi.fn(),
  refresh: vi.fn(async () => null),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/one-voice/session-store", () => ({
  useVoiceToolEffects: (effects: Effects) => {
    mocks.effects = effects;
  },
}));
vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    invalidateCachedIdentity: mocks.invalidate,
    refreshCurrentUserIdentity: mocks.refresh,
  },
}));

import { ProfileIdentityVoiceRefresh } from "@/components/profile/profile-identity-voice-refresh";

const result = (status: string, extra: Record<string, unknown> = {}): ToolResultPublic =>
  ({ status, spoken_facts: [], ...extra }) as unknown as ToolResultPublic;

describe("ProfileIdentityVoiceRefresh", () => {
  beforeEach(() => {
    mocks.effects = {};
    mocks.invalidate.mockClear();
    mocks.refresh.mockClear();
    mocks.user.reload.mockClear();
  });

  it("refreshes both identity paths after a name change with no editor mounted", () => {
    render(<ProfileIdentityVoiceRefresh />);
    mocks.effects.onToolResult?.("update_display_name", result("updated", { display_name: "Ayesha S" }));
    expect(mocks.invalidate).toHaveBeenCalledWith("uid-1");
    expect(mocks.refresh).toHaveBeenCalledWith(mocks.user, { force: true });
    expect(mocks.user.reload).toHaveBeenCalledTimes(1);
  });

  it("refreshes on a committed-but-syncing name so the shadow can catch up", () => {
    render(<ProfileIdentityVoiceRefresh />);
    mocks.effects.onToolResult?.(
      "update_display_name",
      result("committed_sync_pending", { display_name: "Ayesha S" }),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.user.reload).toHaveBeenCalledTimes(1);
  });

  it("collapses the tool.result and pending_action.resolved mirror pair into one refresh", () => {
    render(<ProfileIdentityVoiceRefresh />);
    const r = result("updated", { display_name: "Ayesha S" });
    mocks.effects.onToolResult?.("update_display_name", r);
    mocks.effects.onPendingResolved?.("pa-1", "executed", r);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.user.reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a refused name or another tool", () => {
    render(<ProfileIdentityVoiceRefresh />);
    mocks.effects.onToolResult?.("update_display_name", result("invalid"));
    mocks.effects.onToolResult?.("rename_circle", result("updated"));
    mocks.effects.onPendingResolved?.("pa-2", "cancelled", result("updated", { display_name: "X" }));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.user.reload).not.toHaveBeenCalled();
  });
});
