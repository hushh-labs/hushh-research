import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RequestScopeButton } from "@/components/consent/request-scope-button";
const mocks = vi.hoisted(() => ({ gates: vi.fn(), create: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "requester" } }),
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: async () => "token" },
}));
vi.mock("@/lib/services/answer-request-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/answer-request-service")>()),
  AnswerRequestService: { gates: mocks.gates, create: mocks.create },
}));
beforeEach(() => {
  mocks.gates.mockReset();
  mocks.create.mockReset();
});

// The regression: an unavailable deployment rendered a permanently disabled
// trigger, so an active connection clicked a dead control and was told
// nothing. Every active connection must be able to open the composer.
it("opens with a reason and a next step when intake is switched off", async () => {
  mocks.gates.mockResolvedValue({ requests: false, payments: false });
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  const button = screen.getByRole("button", { name: "Request scope" });
  await waitFor(() => expect(mocks.gates).toHaveBeenCalled());
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(
    screen.getByText(/Requests are not switched on here yet/),
  ).toBeVisible();
  const explanation = screen.getByRole("status").parentElement!;
  expect(within(explanation).getByRole("button", { name: "Close", exact: true })).toBeVisible();
  expect(screen.queryByText(/Request files|Drive/)).toBeNull();
});

// Negative control for the same state: explaining the block must not also
// hand over a form whose submit the server would 503.
it("offers no question form or send control while intake is off", async () => {
  mocks.gates.mockResolvedValue({ requests: false, payments: false });
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  await waitFor(() => expect(mocks.gates).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(screen.queryByLabelText("Your question")).toBeNull();
  expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("opens the existing question dialog on an available active connection", async () => {
  mocks.gates.mockResolvedValue({ requests: true, payments: true });
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Request scope" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(await screen.findByLabelText("Your question")).toBeVisible();
});


it("sends only the question and confirms after server acceptance", async () => {
  mocks.gates.mockResolvedValue({ requests: true, payments: true });
  let accept!: (value: { requestId: string }) => void;
  mocks.create.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  const field = await screen.findByLabelText("Your question");
  expect(field).toHaveAttribute("placeholder", "What is the best way to contact you?");
  expect(screen.getByText("To Asha")).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(document.querySelector('input[type="date"]')).toBeNull();
  expect(screen.queryByText(/Period|Start date|End date|files|Drive/)).toBeNull();
  const send = screen.getByRole("button", { name: "Send request" });
  expect(send).toBeDisabled();
  const question = "How much did you spend on travel from January through March 2026?";
  fireEvent.change(field, { target: { value: question } });
  expect(send).toBeEnabled();
  fireEvent.click(send);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("token", "connected-person", { question }));
  expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
  expect(screen.queryByText(/Request sent/)).toBeNull();
  accept({ requestId: "33333333-3333-4333-8333-333333333333" });
  expect(await screen.findByText(/Request sent/)).toBeVisible();
  expect(screen.getByRole("link", { name: "View request" })).toHaveAttribute(
    "href", expect.stringContaining("answer_request"),
  );
});

it("retains a failed question and Cancel resets the next request", async () => {
  mocks.gates.mockResolvedValue({ requests: true, payments: true });
  mocks.create.mockRejectedValue(new Error("This request could not be sent."));
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  const field = await screen.findByLabelText("Your question");
  fireEvent.change(field, { target: { value: "What is your age?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be sent");
  expect(field).toHaveValue("What is your age?");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(await screen.findByLabelText("Your question")).toHaveValue("");
});

// The regression this change fixes: the dialog read one flag for both gates,
// so a deployment with request intake on and payments still paused hid the
// question box behind the paywall. Intake alone admits the form; the owner
// has to approve scopes and set a price before payment is ever reached.
it("shows the question form when intake is on and payments are paused", async () => {
  mocks.gates.mockResolvedValue({ requests: true, payments: false });
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(await screen.findByLabelText("Your question")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send request" })).toBeVisible();
  expect(screen.queryByText(/not switched on here yet/)).toBeNull();
  // Nothing in this form may offer to charge for the answer.
  expect(screen.queryByText(/\$|Pay|Checkout/)).toBeNull();
});

// Negative control for the gate split: intake off must still close the form
// even when payments are fully live, so the kill switch keeps working.
it("closes the form when intake is off even with payments live", async () => {
  mocks.gates.mockResolvedValue({ requests: false, payments: true });
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(
    await screen.findByText(/Requests are not switched on here yet/),
  ).toBeVisible();
  expect(screen.queryByLabelText("Your question")).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});

// A sign-in or network failure previously rendered the same "switched off"
// sentence, which was simply untrue and offered no way forward.
it("distinguishes a failed check from a disabled lane and retries", async () => {
  mocks.gates.mockRejectedValueOnce(new Error("Sign in to send this request."));
  mocks.gates.mockResolvedValueOnce({ requests: true, payments: false });
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(await screen.findByText(/Sign in to send this request/)).toBeVisible();
  expect(screen.queryByText(/not switched on here yet/)).toBeNull();
  expect(screen.queryByLabelText("Your question")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByLabelText("Your question")).toBeVisible();
});


it("retains the pending question and blocks form submission while connection authority is unavailable", async () => {
  mocks.gates.mockResolvedValue({ requests: true, payments: false });
  const view = render(<RequestScopeButton personRef="connected-person" personName="Asha" canRequest />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  const field = await screen.findByLabelText("Your question");
  fireEvent.change(field, { target: { value: "What are your food preferences?" } });
  const send = screen.getByRole("button", { name: "Send request" });
  expect(send).toBeEnabled();
  view.rerender(<RequestScopeButton personRef="connected-person" personName="Asha" canRequest={false} />);
  expect(field).toHaveValue("What are your food preferences?");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Request scope", exact: true })).toBeNull();
  expect(send).toBeDisabled();
  fireEvent.submit(send.closest("form")!);
  expect(mocks.create).not.toHaveBeenCalled();
  view.rerender(<RequestScopeButton personRef="connected-person" personName="Asha" canRequest />);
  expect(field).toHaveValue("What are your food preferences?");
  expect(send).toBeEnabled();
});
