import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  expect(screen.getByText(/Request files still works/)).toBeVisible();
});

// Negative control for the same state: explaining the block must not also
// hand over a form whose submit the server would 503.
it("offers no question form or send control while unavailable", async () => {
  mocks.available.mockResolvedValue(false);
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  await waitFor(() => expect(mocks.available).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Request scope" }));
  expect(screen.queryByLabelText("What do you need?")).toBeNull();
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
  expect(screen.getByLabelText("What do you need?")).toBeVisible();
});
