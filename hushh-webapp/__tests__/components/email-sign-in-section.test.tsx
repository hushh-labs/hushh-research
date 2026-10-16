import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailSignInSection } from "@/components/onboarding/EmailSignInSection";
import { resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { emailAuthRequest: (action: string, ...args: unknown[]) =>
  action === "capabilities" ? Promise.resolve({ enabled: true, microsoft: true }) : request(action, ...args) } }));

const challenge = { status: "accepted", challenge_id: "opaque-challenge", destination: "p***@example.com",
  expires_at: new Date(Date.now() + 300_000).toISOString(), resend_at: Date.now() / 1000 + 60 };

async function enterCode() {
  fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "person@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
  await screen.findByLabelText("Six-digit code");
  fireEvent.change(screen.getByLabelText("Six-digit code"), { target: { value: "001234" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
}

describe("Email sign-in authority handoff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates only after successful proof and preserves leading-zero codes", async () => {
    request.mockResolvedValueOnce(challenge).mockResolvedValueOnce({ status: "authenticated", custom_token: "opaque-token" });
    const authenticated = vi.fn().mockResolvedValue(undefined);
    render(<EmailSignInSection disabled={false} onBusyChange={vi.fn()} onExpandedChange={vi.fn()} onAuthenticated={authenticated} />);
    await enterCode();
    await waitFor(() => expect(authenticated).toHaveBeenCalledWith("opaque-token"));
    expect(request).toHaveBeenLastCalledWith("verify", expect.objectContaining({ code: "001234" }));
  });

  it("drops a late verification response after the form is unmounted", async () => {
    let resolve!: (value: unknown) => void;
    request.mockResolvedValueOnce(challenge).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const authenticated = vi.fn();
    const view = render(<EmailSignInSection disabled={false} onBusyChange={vi.fn()} onExpandedChange={vi.fn()} onAuthenticated={authenticated} />);
    await enterCode();
    view.unmount();
    await act(async () => resolve({ status: "authenticated", custom_token: "late-token" }));
    expect(authenticated).not.toHaveBeenCalled();
  });

  it("counts down to expiry and disables verification after returning from a hidden tab", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    let visibility: DocumentVisibilityState = "visible";
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      setTimeout(() => callback(performance.now()), 16);
      return 1;
    });
    request.mockResolvedValueOnce({ ...challenge,
      expires_at: new Date(Date.now() + 300_000).toISOString(), resend_at: Date.now() / 1000 + 60 });
    const authenticated = vi.fn();
    const view = render(<EmailSignInSection disabled={false} onBusyChange={vi.fn()} onExpandedChange={vi.fn()} onAuthenticated={authenticated} />);
    try {
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "person@example.com" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" })); });
      fireEvent.change(screen.getByLabelText("Six-digit code"), { target: { value: "001234" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_030); });
      expect(screen.getByRole("timer")).toHaveTextContent("Code expires in 4:59.");
      expect(screen.getByRole("button", { name: "Verify and sign in" })).toBeEnabled();
      expect(screen.getByRole("button", { name: /Resend in/ })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(screen.getByRole("timer")).toHaveTextContent("Code expires in 4:58.");
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled();
      visibility = "hidden";
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      visibility = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByRole("timer")).toHaveTextContent("This code expired. Request a new one.");
      expect(screen.getByLabelText("Six-digit code")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Verify and sign in" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled();
      expect(request).toHaveBeenCalledTimes(1);
      expect(authenticated).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      resetIdleSchedulerForTests();
      if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
