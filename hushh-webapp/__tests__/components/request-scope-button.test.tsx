import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RequestScopeButton } from "@/components/consent/request-scope-button";
const mocks = vi.hoisted(() => ({ available: vi.fn(), create: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "requester" } }),
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: async () => "token" },
}));
vi.mock("@/lib/services/answer-request-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/answer-request-service")>()),
  AnswerRequestService: { available: mocks.available, create: mocks.create },
}));
beforeEach(() => {
  mocks.available.mockReset();
  mocks.create.mockReset();
});

// The regression: an unavailable deployment rendered a permanently disabled
// trigger, so an active connection clicked a dead control and was told
// nothing. Every active connection must be able to open the composer.
it("opens with a reason and a next step when the lane is unavailable", async () => {
  mocks.available.mockResolvedValue(false);
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  const button = screen.getByRole("button", { name: "Request scope" });
  await waitFor(() => expect(mocks.available).toHaveBeenCalled());
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(
    screen.getByText(/Paid answers are not switched on here yet/),
  ).toBeVisible();
  const explanation = screen.getByRole("status").parentElement!;
  expect(within(explanation).getByRole("button", { name: "Close", exact: true })).toBeVisible();
  expect(screen.queryByText(/Request files|Drive/)).toBeNull();
});

// Negative control for the same state: explaining the block must not also
// hand over a form whose submit the server would 503.
it("offers no question form or send control while unavailable", async () => {
  mocks.available.mockResolvedValue(false);
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  await waitFor(() => expect(mocks.available).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(screen.queryByLabelText("Question")).toBeNull();
  expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("opens the existing question dialog on an available active connection", async () => {
  mocks.available.mockResolvedValue(true);
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Request scope" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(await screen.findByLabelText("Question")).toBeVisible();
});


it("sends only the question and confirms after server acceptance", async () => {
  mocks.available.mockResolvedValue(true);
  let accept!: (value: { requestId: string }) => void;
  mocks.create.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  const field = await screen.findByLabelText("Question");
  expect(field).toHaveAttribute("placeholder", "E.g. What is your age?");
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
  mocks.available.mockResolvedValue(true);
  mocks.create.mockRejectedValue(new Error("This request could not be sent."));
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  const field = await screen.findByLabelText("Question");
  fireEvent.change(field, { target: { value: "What is your age?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be sent");
  expect(field).toHaveValue("What is your age?");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(await screen.findByLabelText("Question")).toHaveValue("");
});
