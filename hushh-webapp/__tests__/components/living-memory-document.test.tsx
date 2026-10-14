import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  uid: "owner-a",
  unlocked: true,
  token: "fixture-token-0",
  epoch: 0,
  markdown: "SYNTHETIC_A",
  listeners: new Set<() => void>(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: m.unlocked,
    vaultOwnerToken: m.token,
    vaultKey: "fixture-key",
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => m.epoch,
}));
vi.mock("@/lib/pkm/memory-refresh", () => ({
  peekMemoryView: () => ({
    status: "current",
    builtAt: "2026-10-11T00:00:00Z",
    document: { markdown: m.markdown },
  }),
}));
vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({
      subscribe: (listener: () => void) => {
        m.listeners.add(listener);
        return () => {
          m.listeners.delete(listener);
        };
      },
    }),
  },
}));
import { LivingMemoryDocument } from "@/components/profile/living-memory-document";
beforeEach(() => {
  m.uid = "owner-a";
  m.unlocked = true;
  m.token = "fixture-token-0";
  m.epoch = 0;
  m.markdown = "SYNTHETIC_A";
  m.listeners.clear();
  m.push.mockReset();
});
afterEach(cleanup);
it("does not carry one owner document into another account", () => {
  const view = render(<LivingMemoryDocument />);
  expect(screen.getByText("SYNTHETIC_A")).toBeInTheDocument();
  m.uid = "owner-b";
  m.epoch++;
  m.token = "fixture-b-token";
  m.markdown = "SYNTHETIC_B";
  view.rerender(<LivingMemoryDocument />);
  expect(screen.queryByText("SYNTHETIC_A")).not.toBeInTheDocument();
  expect(screen.getByText("SYNTHETIC_B")).toBeInTheDocument();
});
it("clears the visible document while locked and accepts fresh unlocked readback", () => {
  const view = render(<LivingMemoryDocument />);
  m.unlocked = false;
  m.epoch++;
  view.rerender(<LivingMemoryDocument />);
  expect(screen.queryByText("SYNTHETIC_A")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Saved and Add/ }),
  ).not.toBeInTheDocument();
  m.unlocked = true;
  m.token = "fixture-token-1";
  m.markdown = "SYNTHETIC_REBUILT";
  view.rerender(<LivingMemoryDocument />);
  expect(screen.queryByText("SYNTHETIC_A")).not.toBeInTheDocument();
  expect(screen.getByText("SYNTHETIC_REBUILT")).toBeInTheDocument();
});
it("opens the existing Memory workspace without retaining the Profile pane", () => {
  render(<LivingMemoryDocument />);
  fireEvent.click(screen.getByRole("button", { name: /Saved and Add/ }));
  expect(m.push).toHaveBeenCalledOnce();
  expect(m.push).toHaveBeenCalledWith("/one/pkm");
  expect(screen.getByText("SYNTHETIC_A")).toBeInTheDocument();
});
it("accepts fresh readback after token renewal without requiring another lock", () => {
  const view = render(<LivingMemoryDocument />);
  m.epoch++;
  m.token = "fixture-token-1";
  m.markdown = "SYNTHETIC_RENEWED";
  view.rerender(<LivingMemoryDocument />);
  act(() => {
    for (const listener of m.listeners) listener();
  });
  expect(screen.queryByText("SYNTHETIC_A")).not.toBeInTheDocument();
  expect(screen.getByText("SYNTHETIC_RENEWED")).toBeInTheDocument();
  expect(screen.getByText("Living memory · current")).toBeInTheDocument();
  view.unmount();
  expect(m.listeners.size).toBe(0);
});
