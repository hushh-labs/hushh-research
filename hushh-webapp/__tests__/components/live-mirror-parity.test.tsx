import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveMirrorView } from "@/lib/pkm/live-mirror-contract";

const m = vi.hoisted(() => ({ view: null as LiveMirrorView | null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "owner-a" }, userId: "owner-a" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: true, vaultOwnerToken: "fixture-token", vaultKey: "fixture-key" }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 0 }));
vi.mock("@/lib/pkm/memory-refresh", () => ({ peekLiveMirror: () => m.view }));

import { LiveMirrorPreview } from "@/components/profile/live-mirror-preview";
import { LivingMemoryDocument } from "@/components/profile/living-memory-document";
import { applyLiveMirrorReadTime, buildLiveMirrorProjection } from "@/lib/pkm/live-mirror-projection";
import { appendVerifiedLivingSourceChanges, reconcileLivingSources, type LivingSourceInput } from "@/lib/pkm/living-source-records";

const T = "2026-10-15T10:00:00.000Z";

function realView(inputs: LivingSourceInput[], kinds: string[]): LiveMirrorView {
  const inventory = reconcileLivingSources(null, inputs, kinds, [], T);
  const history = appendVerifiedLivingSourceChanges(null, null, inventory);
  const projection = buildLiveMirrorProjection({ ownerId: "owner-a", vaultEpoch: 0, now: T, inventory, history, document: null });
  return applyLiveMirrorReadTime(projection, "2026-10-15T10:01:30.000Z", "current");
}

/** The status line, check time and one record row as each surface renders them. */
function previewReading() {
  const view = render(<LiveMirrorPreview />);
  const status = view.getByTestId("live-mirror-status");
  const reading = {
    headline: within(status).getByRole("status").textContent,
    sub: status.querySelector('[data-slot="settings-row-description"]')?.textContent ?? null,
    earning: view.queryAllByTestId("live-mirror-fact").find(row => row.textContent?.startsWith("Earning 1"))?.textContent ?? null,
  };
  view.unmount();
  return reading;
}
function profileReading() {
  const view = render(<LivingMemoryDocument />);
  const status = view.getByRole("status");
  const reading = {
    headline: status.textContent,
    sub: status.nextElementSibling?.textContent ?? null,
    earning: view.queryByRole("button", { name: /^Earning 1/ })?.textContent ?? null,
  };
  view.unmount();
  return reading;
}

afterEach(cleanup);

it("Profile and the shared preview read one view the same way: value, status and check time", () => {
  m.view = realView([
    { kind: "profile", id: "owner-a", createdAt: null, updatedAt: T, value: { name: "Ankit", email: "owner@example.test" } },
    { kind: "document_earning", id: "e1", createdAt: T, updatedAt: T,
      value: { stripeMode: "live", status: "succeeded", grossCents: 123_456, createdAt: T } },
  ], ["profile", "document_earning"]);
  const preview = previewReading();
  expect(preview).toEqual({ headline: "Up to date", sub: "Checked 1 min ago", earning: expect.stringContaining("$1,234.56") });
  expect(profileReading()).toEqual(preview);

  m.view = realView([], ["profile"]);
  const empty = previewReading();
  expect(empty).toMatchObject({ headline: "Nothing yet", sub: "New changes will show here" });
  expect(profileReading()).toEqual(empty);
});
