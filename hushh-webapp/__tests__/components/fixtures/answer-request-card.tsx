// Synthetic auth, transport and crypto boundaries shared by production card tests.
import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, vi } from "vitest";
const m = vi.hoisted(() => ({
  uid: "owner-a",
  unlocked: true,
  epoch: 0,
  authGeneration: 0,
  vaultToken: "fixture-owner-token",
  token: vi.fn(),
  inbox: vi.fn(),
  payment: vi.fn(),
  state: vi.fn(),
  answer: vi.fn(),
  checkout: vi.fn(),
  cancel: vi.fn(),
  gates: vi.fn(),
  decrypt: vi.fn(),
  sweep: vi.fn(),
  keyId: vi.fn(),
  setup: vi.fn(),
}));
export { m };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid }, userId: m.uid }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: m.unlocked,
    vaultKey: "fixture-key",
    vaultOwnerToken: m.vaultToken,
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => m.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === m.epoch,
}));
vi.mock("@/lib/auth/session-owner", () => ({ getAuthSessionGeneration: () => m.authGeneration }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: m.token },
}));
vi.mock("@/lib/services/answer-request-service", () => ({
  AnswerRequestService: {
    inbox: m.inbox,
    payment: m.payment,
    state: async (...args: unknown[]) => ({ requesterKeyReady: true, deliveryRecipientKeyId: "fixture-key", ...await m.state(...args) }),
    answer: m.answer,
    checkout: m.checkout,
    cancel: m.cancel,
    gates: m.gates,
  },
}));
vi.mock("@/lib/one-marketplace/encryption", () => ({
  decryptMarketplaceEnvelope: m.decrypt,
  marketplaceRecipientKeyId: m.keyId,
}));
vi.mock("@/lib/one-marketplace/key-bootstrap", () => ({ bootstrapCurrentUserMarketplaceRecipientKey: m.setup }));
vi.mock("@/lib/answers/answer-delivery-sweep", () => ({
  runAnswerDeliverySweep: m.sweep,
}));
vi.mock("@/components/consent/answer-request-review", () => ({
  AnswerRequestReview: () => <p>Owner review</p>,
}));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/app-ui/typography", () => ({
  BodyText: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  HelperText: ({ children, role }: { children: ReactNode; role?: string }) => (
    <p role={role}>{children}</p>
  ),
}));
vi.mock("@/components/app-ui/settings-ui", () => ({
  SettingsRow: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <div>
      {title} {description}
    </div>
  ),
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open, onSuccess, onOpenChange, allowVaultCreation }: {
    open: boolean;
    onSuccess: () => void;
    onOpenChange: (open: boolean) => void;
    allowVaultCreation: boolean;
  }) => open ? (
    <div role="dialog" aria-label="Requester unlock" data-allow-creation={String(allowVaultCreation)}>
      <button onClick={() => { m.unlocked = true; m.epoch++; onSuccess(); }}>Unlock fixture</button>
      <button onClick={() => onOpenChange(false)}>Close unlock</button>
    </div>
  ) : null,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
export const REQUEST = "11111111-2222-3333-4444-555555555555";
export const OTHER_REQUEST = "22222222-3333-4444-8555-666666666666";

export const FULL_COVERAGE = {
  included: [{ scope: "attr.travel.trips", label: "Trips" }],
  notIncluded: [],
};
export const PARTIAL_COVERAGE = {
  included: [
    { scope: "attr.identity.identity_profile.sex", label: "Sex" },
    { scope: "attr.location.saved_places", label: "Saved places" },
  ],
  notIncluded: [{ scope: "attr.identity.identity_profile.declared_age", label: "Age" }],
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.keyId.mockResolvedValue("fixture-key");
  m.setup.mockResolvedValue({ keyId: "fixture-key" });
  m.uid = "owner-a";
  m.unlocked = true;
  m.epoch = 0;
  m.authGeneration = 0;
  m.vaultToken = "fixture-owner-token";
  m.token.mockResolvedValue("fixture-id-token");
  m.inbox.mockResolvedValue([]);
  m.gates.mockResolvedValue({ requests: true, payments: true, payouts: true });
  m.state.mockResolvedValue({
    role: "requester",
    requestStatus: "answered",
    question: "Fixture question",
  });
  m.payment.mockResolvedValue({
    requestStatus: "answered",
    orderStatus: "paid",
    preparationStatus: "ready",
    reconciliationRequired: false,
    amountCents: 1000,
    answerDeadlineHours: 72,
  });
  m.answer.mockResolvedValue({ recipientKeyId: "fixture-envelope" });
  m.decrypt.mockResolvedValue({ version: 1, answerMode: "agent", answer: "SYNTHETIC_ANSWER", memory: "INTERNAL_DEBUG" });
  m.sweep.mockResolvedValue({ delivered: 1, empty: 0 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
