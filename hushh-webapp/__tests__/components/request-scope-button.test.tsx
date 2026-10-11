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
it("shows Request scope while availability is disabled", async () => {
  mocks.available.mockResolvedValue(false);
  render(<RequestScopeButton personRef="connected-person" personName="Asha" />);
  const button = screen.getByRole("button", { name: "Request scope" });
  await waitFor(() => expect(mocks.available).toHaveBeenCalled());
  expect(button).toBeDisabled();
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
