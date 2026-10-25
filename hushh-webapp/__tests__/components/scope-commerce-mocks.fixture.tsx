import { vi } from "vitest";
export const readiness = () => ({ schema_version: 1 as const, enabled: true, free: { requires_payment_provider: false as const, requires_owner_approval: true as const, tariff_controls_available: true },
  platform: { status: "ready" as const, reason_code: null, verification_scope: "configured_and_persisted" as const }, seller: { status: "not_onboarded" as const, reason_code: "seller_onboarding_required" as const },
  capabilities: { set_free_tariff: true, set_paid_tariff: false, approve_paid_request: false, reserve_paid_purchase: true, start_funding: true, start_onboarding: true } });
export const unavailable = () => ({ ...readiness(), enabled: false, platform: { ...readiness().platform, status: "disabled" as const, reason_code: "commerce_disabled" as const }, capabilities: { set_free_tariff: true, set_paid_tariff: false, approve_paid_request: false, reserve_paid_purchase: false, start_funding: false, start_onboarding: false } });
export const balanceAccount = () => ({ enabled: true, readiness: readiness(), currency: "USD", balance: { available_cents: 1, reserved_cents: 0 },
  earnings: { pending_cents: 0, available_cents: 0 }, seller: { onboarded: false, eligible: false, country: "US" },
  payout: { minimum_net_cents: 50 }, funding_lots: [] });
import type { ReactNode, ButtonHTMLAttributes } from "react";

const mocks = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "owner-token") } as { uid: string; getIdToken: () => Promise<string> } | null,
  readiness: vi.fn(), sandboxVerified: vi.fn(), tariff: vi.fn(), saveTariff: vi.fn(), account: vi.fn(), activity: vi.fn(), onboarding: vi.fn(), management: vi.fn(), hosted: vi.fn(), periodic: vi.fn(),
  scopeRequest: vi.fn(), quote: vi.fn(), purchase: vi.fn(), exporter: vi.fn(), checkout: vi.fn(),
  pathname: "/one/profile/payouts", search: "", vaultKey: "memory-key", openWindow: vi.fn(),
  answerGates: vi.fn(), answerAccount: vi.fn(), answerLink: vi.fn(), answerOnboarding: vi.fn(),
}));
vi.mock("@/lib/services/answer-request-service", () => ({ AnswerRequestService: {
  gates: mocks.answerGates, payoutAccount: mocks.answerAccount, payoutLink: mocks.answerLink, payoutOnboarding: mocks.answerOnboarding,
} }));
vi.mock("@/components/consent/document-hashcoins", () => ({ DocumentHashcoinPayouts: () => null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/profile/use-native-payouts", () => ({ useNativePayouts: () => ({
  pages: [{ id: "payouts", title: "Payments and earnings", sections: [] }], rows: new Map(), busy: false,
  back: () => false, ancestor: () => false, reset: () => undefined, onPresented: () => undefined,
}) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: mocks.vaultKey, getVaultOwnerToken: () => "vault-owner-token" }) }));
vi.mock("@/lib/consent/scope-commerce-export", () => ({ prepareAndStagePaidScopeExport: mocks.exporter }));
vi.mock("@/lib/services/scope-commerce-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/scope-commerce-service")>(),
  ScopeCommerceService: { readiness: mocks.readiness, sandboxVerified: mocks.sandboxVerified, tariff: mocks.tariff, saveTariff: mocks.saveTariff, account: mocks.account, activity: mocks.activity, onboarding: mocks.onboarding, managePayoutAccount: mocks.management,
    scopeRequest: mocks.scopeRequest, quote: mocks.quote, purchase: mocks.purchase, checkout: mocks.checkout },
}));
vi.mock("@/lib/services/scope-commerce-browser", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/scope-commerce-browser")>(), openCommerceHostedUrl: mocks.hosted, openCommerceHostedWindow: mocks.openWindow,
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({ usePeriodicTask: mocks.periodic, useCoarseClock: () => Date.now() }));
vi.mock("@/components/ui/button", async () => {
  const { Slot } = await import("@radix-ui/react-slot");
  return { buttonVariants: () => "", Button: ({ children, variant: _variant, asChild, size: _size, showRipple: _ripple, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; asChild?: boolean; size?: string; showRipple?: boolean }) => asChild ? <Slot {...props}>{children}</Slot> : <button {...props}>{children}</button> };
});
vi.mock("@/components/app-ui/settings-ui", () => ({ SettingsGroup: ({ title, children }: { title: string; children: ReactNode }) => <section aria-label={title}>{children}</section> }));

export { mocks };

