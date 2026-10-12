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
  gates: vi.fn(),
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
    gates: m.gates,
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
import { AnswerRequestCard } from "@/components/consent/answer-request-card";
const REQUEST = "11111111-2222-3333-4444-555555555555";
const OTHER_REQUEST = "22222222-3333-4444-8555-666666666666";
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
afterEach(() => { cleanup(); vi.useRealTimers(); });
it.each(["lock", "owner", "request"])(
  "does not decrypt when %s changes while an envelope is pending",
  async (change) => {
    const read = deferred<unknown>();
    m.answer.mockReturnValue(read.promise);
    const view = render(<AnswerRequestCard requestId={REQUEST} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
    await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(1));
    if (change !== "request") m.epoch++;
    if (change === "lock") m.unlocked = false;
    else if (change === "owner") m.uid = "owner-b";
    view.rerender(<AnswerRequestCard requestId={change === "request" ? OTHER_REQUEST : REQUEST} />);
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

// Request intake and payments are independent gates, so an approved, priced
// request can exist in a deployment that cannot charge for it. Offering Pay
// there is a dead control: checkout 503s. The price and Cancel must survive,
// because the request itself is intact and /cancel is ungated.
it("shows the price but no Pay control while payments are paused", async () => {
  m.gates.mockResolvedValue({ requests: true, payments: false, payouts: false });
  m.state.mockResolvedValue({
    role: "requester",
    requestStatus: "approved",
    question: "Fixture question",
  });
  m.payment.mockResolvedValue({
    requestStatus: "approved",
    orderStatus: "awaiting_payment",
    preparationStatus: "ready",
    reconciliationRequired: false,
    amountCents: 1000,
    answerDeadlineHours: 72,
  });
  render(<AnswerRequestCard requestId={REQUEST} />);
  expect(
    await screen.findByText(/Paying for answers is not switched on here yet/),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
  expect(screen.getByText(/\$10/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Cancel request/ }),
  ).toBeVisible();
  expect(m.checkout).not.toHaveBeenCalled();
});

// Negative control: with payments on, the same state still offers Pay, so
// the gate cannot be satisfied by simply never rendering checkout.
it("still offers Pay when payments are on", async () => {
  m.state.mockResolvedValue({
    role: "requester",
    requestStatus: "approved",
    question: "Fixture question",
  });
  m.payment.mockResolvedValue({
    requestStatus: "approved",
    orderStatus: "awaiting_payment",
    preparationStatus: "ready",
    reconciliationRequired: false,
    amountCents: 1000,
    answerDeadlineHours: 72,
  });
  render(<AnswerRequestCard requestId={REQUEST} />);
  expect(await screen.findByRole("button", { name: /^Pay /})).toBeVisible();
  expect(screen.queryByText(/not switched on here yet/)).toBeNull();
});


it.each(["preparing", "empty", undefined])(
  "does not offer payment without a nonempty completed staged answer (%s)",
  async (preparationStatus) => {
    m.state.mockResolvedValue({ role: "requester", requestStatus: "approved", question: "Fixture question" });
    m.payment.mockResolvedValue({ requestStatus: "approved", orderStatus: "awaiting_payment",
      amountCents: 1000, preparationStatus, reconciliationRequired: false });
    render(<AnswerRequestCard requestId={REQUEST} />);
    await screen.findByRole("button", { name: "Refresh question" });
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    expect(m.checkout).not.toHaveBeenCalled();
    if (preparationStatus === "empty") {
      expect(screen.getByRole("status")).toHaveTextContent("does not contain an answer");
    } else {
      expect(screen.getByRole("status")).toHaveTextContent("being prepared");
      expect(screen.getByRole("status")).not.toHaveTextContent("does not contain an answer");
    }
  },
);

it("retries a failed requester status read without treating it as an absent answer", async () => {
  m.payment.mockRejectedValueOnce(new Error("temporary status failure"));
  render(<AnswerRequestCard requestId={REQUEST} />);
  expect(await screen.findByText(/Payment status could not be checked/)).toBeVisible();
  expect(screen.queryByText(/does not contain an answer/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh question" }));
  expect(await screen.findByRole("button", { name: "Open answer" })).toBeVisible();
  expect(m.payment).toHaveBeenCalledTimes(2);
});

it("keeps retrying paid preparation through a status failure until the answer arrives", async () => {
  vi.useFakeTimers();
  const answering = { role: "requester", requestStatus: "answering", question: "Fixture question" };
  m.state.mockResolvedValueOnce(answering).mockResolvedValueOnce(answering);
  m.payment
    .mockResolvedValueOnce({ requestStatus: "answering", orderStatus: "paid", preparationStatus: "ready",
      reconciliationRequired: false, amountCents: 1000 })
    .mockRejectedValueOnce(new Error("temporary status failure"));
  render(<AnswerRequestCard requestId={REQUEST} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("Paid");
  expect(screen.queryByRole("button", { name: "Open answer" })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText(/Payment status could not be checked/)).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole("button", { name: "Open answer" })).toBeVisible();
  expect(m.payment).toHaveBeenCalledTimes(3);
});

it("renders the purchased answer as readable Markdown and excludes internal envelope records", async () => {
  m.decrypt.mockResolvedValue({ version: 1, answerMode: "agent",
    answer: "## Your answer\n\nYour age is **32**.",
    memory: "INTERNAL_MEMORY_DEBUG", approvedInformation: { age: 32, internal: "INTERNAL_SCOPE_DEBUG" },
    sourceRevisions: { identity: 7 } });
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
  expect(await screen.findByRole("heading", { name: "Your answer" })).toBeVisible();
  expect(screen.getByText("32", { selector: "strong" })).toBeVisible();
  expect(view.container).not.toHaveTextContent("INTERNAL_MEMORY_DEBUG");
  expect(view.container).not.toHaveTextContent("INTERNAL_SCOPE_DEBUG");
  expect(view.container).not.toHaveTextContent("approvedInformation");
  expect(view.container).not.toHaveTextContent("sourceRevisions");
});

it("requires requester unlock and resumes the selected answer with the new session", async () => {
  m.unlocked = false;
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
  expect(screen.getByRole("dialog", { name: "Requester unlock" })).toHaveAttribute("data-allow-creation", "false");
  expect(m.answer).not.toHaveBeenCalled();
  expect(m.decrypt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Unlock fixture" }));
  view.rerender(<AnswerRequestCard requestId={REQUEST} />);
  expect(await screen.findByText("SYNTHETIC_ANSWER")).toBeVisible();
  expect(m.answer).toHaveBeenCalledWith("fixture-id-token", REQUEST);
  expect(m.decrypt).toHaveBeenCalledWith({ userId: "owner-a", envelope: { recipientKeyId: "fixture-envelope" } });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["close", "owner", "request"])("drops a pending requester open on %s before unlock", async (change) => {
  m.unlocked = false;
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
  if (change === "close") fireEvent.click(screen.getByRole("button", { name: "Close unlock" }));
  if (change === "owner") { m.uid = "owner-b"; m.epoch++; }
  const nextRequest = change === "request" ? OTHER_REQUEST : REQUEST;
  view.rerender(<AnswerRequestCard requestId={nextRequest} />);
  m.unlocked = true;
  m.epoch++;
  view.rerender(<AnswerRequestCard requestId={nextRequest} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(m.answer).not.toHaveBeenCalled();
  expect(m.decrypt).not.toHaveBeenCalled();
  expect(screen.queryByText("SYNTHETIC_ANSWER")).toBeNull();
});

it("does not decrypt an old request after the selection changes during authentication", async () => {
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  await screen.findByRole("button", { name: "Open answer" });
  const token = deferred<string>();
  m.token.mockReturnValueOnce(token.promise);
  fireEvent.click(screen.getByRole("button", { name: "Open answer" }));
  view.rerender(<AnswerRequestCard requestId={OTHER_REQUEST} />);
  await act(async () => { token.resolve("fixture-id-token"); await token.promise; });
  expect(m.answer).not.toHaveBeenCalled();
  expect(m.decrypt).not.toHaveBeenCalled();
});


it("does not publish decrypted plaintext from the previous question after selection changes", async () => {
  const decrypted = deferred<unknown>();
  m.decrypt.mockReturnValueOnce(decrypted.promise);
  const view = render(<AnswerRequestCard requestId={REQUEST} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open answer" }));
  await waitFor(() => expect(m.decrypt).toHaveBeenCalledTimes(1));
  view.rerender(<AnswerRequestCard requestId={OTHER_REQUEST} />);
  await act(async () => {
    decrypted.resolve({ version: 1, answerMode: "agent", answer: "OLD_QUESTION_ANSWER" });
    await decrypted.promise;
  });
  expect(screen.queryByText("OLD_QUESTION_ANSWER")).toBeNull();
});
