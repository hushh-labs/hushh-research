import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  uid: "owner-a",
  unlocked: true,
  epoch: 0,
  vaultToken: "fixture-owner-token",
  token: vi.fn(),
  inbox: vi.fn(),
  payment: vi.fn(),
  state: vi.fn(),
  answer: vi.fn(),
  checkout: vi.fn(),
  cancel: vi.fn(),
  decrypt: vi.fn(),
  sweep: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid } }),
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
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: m.token },
}));
vi.mock("@/lib/services/answer-request-service", () => ({
  AnswerRequestService: {
    inbox: m.inbox,
    payment: m.payment,
    state: m.state,
    answer: m.answer,
    checkout: m.checkout,
    cancel: m.cancel,
  },
}));
vi.mock("@/lib/one-marketplace/encryption", () => ({
  decryptMarketplaceEnvelope: m.decrypt,
}));
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
import { AnswerRequestCard } from "@/components/consent/answer-request-card";
const REQUEST = "11111111-2222-3333-4444-555555555555";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.uid = "owner-a";
  m.unlocked = true;
  m.epoch = 0;
  m.vaultToken = "fixture-owner-token";
  m.token.mockResolvedValue("fixture-id-token");
  m.inbox.mockResolvedValue([]);
  m.state.mockResolvedValue({
    role: "requester",
    requestStatus: "answered",
    question: "Fixture question",
  });
  m.payment.mockResolvedValue({
    requestStatus: "answered",
    orderStatus: "paid",
    amountCents: 1000,
    answerDeadlineHours: 72,
  });
  m.answer.mockResolvedValue({ recipientKeyId: "fixture-envelope" });
  m.decrypt.mockResolvedValue({ answer: "SYNTHETIC_ANSWER" });
  m.sweep.mockResolvedValue({ delivered: 1, empty: 0 });
});
afterEach(cleanup);
it.each(["lock", "owner"])(
  "does not decrypt when %s changes while an envelope is pending",
  async (change) => {
    const read = deferred<unknown>();
    m.answer.mockReturnValue(read.promise);
    const view = render(<AnswerRequestCard requestId={REQUEST} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
    await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(1));
    m.epoch++;
    if (change === "lock") m.unlocked = false;
    else m.uid = "owner-b";
    view.rerender(<AnswerRequestCard requestId={REQUEST} />);
    await act(async () => {
      read.resolve({ recipientKeyId: "fixture-envelope" });
      await read.promise;
    });
    expect(m.decrypt).not.toHaveBeenCalled();
    expect(screen.queryByText(/SYNTHETIC_ANSWER/)).not.toBeInTheDocument();
  },
);
it("does not publish decrypted plaintext after locking during crypto", async () => {
  const decrypted = deferred<unknown>();
  m.decrypt.mockReturnValue(decrypted.promise);
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
  await waitFor(() => expect(m.decrypt).toHaveBeenCalledTimes(1));
  m.unlocked = false;
  m.epoch++;
  view.rerender(<AnswerRequestCard requestId={REQUEST} />);
  await act(async () => {
    decrypted.resolve({ answer: "SYNTHETIC_ANSWER" });
    await decrypted.promise;
  });
  expect(screen.queryByText(/SYNTHETIC_ANSWER/)).not.toBeInTheDocument();
});
it("answers only after an explicit owner action and fences a changed session during auth", async () => {
  m.payment.mockResolvedValue(null);
  m.state.mockResolvedValue({
    role: "owner",
    requestStatus: "answering",
    question: "Fixture question",
  });
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  const write = await screen.findByRole("button", { name: "Write answer" });
  expect(m.sweep).not.toHaveBeenCalled();
  const token = deferred<string>();
  m.token.mockReturnValueOnce(token.promise);
  fireEvent.click(write);
  m.epoch++;
  m.vaultToken = "replacement-fixture-token";
  view.rerender(<AnswerRequestCard requestId={REQUEST} />);
  await act(async () => {
    token.resolve("fixture-id-token");
    await token.promise;
  });
  expect(m.sweep).not.toHaveBeenCalled();
});
it("drops previously decrypted display on same-owner custody replacement", async () => {
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
  await screen.findByText(/SYNTHETIC_ANSWER/);
  m.epoch++;
  m.vaultToken = "replacement-fixture-token";
  view.rerender(<AnswerRequestCard requestId={REQUEST} />);
  expect(screen.queryByText(/SYNTHETIC_ANSWER/)).not.toBeInTheDocument();
});
