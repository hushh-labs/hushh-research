import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailSignInSection } from "@/components/onboarding/EmailSignInSection";
import { EmailAuthRequestError } from "@/lib/auth/email-auth-contracts";
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

  it("requires exact Start fresh consent and recovers lost responses through a new code", async () => {
    const review = { previous_generation: 0,
      cleanup_operation: "00000000-0000-4000-8000-000000000001",
      enrollment_operation: "00000000-0000-4000-8000-000000000002",
      expires_at: Math.floor(Date.now() / 1000) + 300, terms_version: 1, digest: "a".repeat(64) };
    request.mockResolvedValueOnce(challenge).mockResolvedValueOnce({ status: "registration_required",
      registration: { state: "ready", review }, enrollment_ticket: "t".repeat(43) })
      .mockRejectedValueOnce(new Error("response lost"));
    const authenticated = vi.fn();
    render(<EmailSignInSection disabled={false} onBusyChange={vi.fn()} onExpandedChange={vi.fn()} onAuthenticated={authenticated} />);
    await enterCode();
    const create = await screen.findByRole("button", { name: "Create new account" });
    expect(create).toBeDisabled();
    expect(authenticated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I want to create a new account." }));
    fireEvent.click(create);
    await screen.findByText("Request a new code to reconnect and check the result.");
    expect(create).toBeDisabled();
    expect(request.mock.calls.filter(([action]) => action === "enroll")).toHaveLength(1);
    expect(request).toHaveBeenLastCalledWith("enroll", expect.objectContaining({
      enrollment_ticket: "t".repeat(43), accepted_review_digest: review.digest, confirmed: true,
    }));
    expect(authenticated).not.toHaveBeenCalled();
  });

  it("keeps historical cleanup without evidence outside registration", async () => {
    request.mockResolvedValueOnce(challenge).mockResolvedValueOnce({ status: "registration_required",
      registration: { state: "action_required", reason: "historical_cleanup_unconfirmed" } });
    const authenticated = vi.fn();
    render(<EmailSignInSection disabled={false} onBusyChange={vi.fn()} onExpandedChange={vi.fn()} onAuthenticated={authenticated} />);
    await enterCode();
    await screen.findByText("Previous account cleanup needs review before you can start fresh.");
    expect(screen.queryByRole("button", { name: "Create new account" })).not.toBeInTheDocument();
    expect(authenticated).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
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

  it.each([
    ["enrollment_changed", 409, "Request a new sign-in code."],
    ["enrollment_expired", 409, "Restart email sign-in."],
    // Finishing sign-in after verify used the code up answers 400 for a lapsed enrollment.
    ["enrollment_expired", 400, "Restart email sign-in."],
  ] as const)(
    "@feature_account_deletion @trace_loop replaces a %s code (HTTP %i) with one new code for the same email", async (error, status, message) => {
      request.mockResolvedValueOnce({ ...challenge, resend_at: 0 })
        .mockRejectedValueOnce(new EmailAuthRequestError(error, message, status))
        .mockResolvedValueOnce({ ...challenge, challenge_id: "opaque-challenge-next" });
      const authenticated = vi.fn();
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      render(<EmailSignInSection disabled={false} onBusyChange={vi.fn()} onExpandedChange={vi.fn()} onAuthenticated={authenticated} />);
      await enterCode();
      expect(await screen.findByRole("alert")).toHaveTextContent("Request a new sign-in code.");
      // The Dev/UAT console names the code and status only, never the address.
      const lines = info.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("[KARMA]"));
      expect(lines).toContainEqual(expect.stringMatching(new RegExp(` email_code\\.code_stale code=${error} status=${status}$`)));
      expect(lines.join("\n")).not.toContain("person@example.com");
      info.mockRestore();
      expect(screen.queryByLabelText("Six-digit code")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Verify and sign in" })).not.toBeInTheDocument();
      const resend = screen.getByRole("button", { name: "Send a new code" });
      await waitFor(() => expect(resend).toBeEnabled());
      fireEvent.click(resend);
      expect(await screen.findByLabelText("Six-digit code")).toHaveValue("");
      const sends = request.mock.calls.filter(([action]) => action === "request");
      expect(sends).toHaveLength(2);
      expect(sends[1][1]).toMatchObject({ email: "person@example.com", browser_binding: sends[0][1].browser_binding });
      expect(sends[1][1].request_key).not.toBe(sends[0][1].request_key);
      expect(authenticated).not.toHaveBeenCalled();
    });

  it("@feature_account_deletion @trace_loop keeps a wrong code editable without the new-code recovery", async () => {
    request.mockResolvedValueOnce({ ...challenge, resend_at: 0 })
      .mockRejectedValueOnce(new EmailAuthRequestError("invalid_code", "The code is invalid or expired.", 400));
    render(<EmailSignInSection disabled={false} onBusyChange={vi.fn()} onExpandedChange={vi.fn()} onAuthenticated={vi.fn()} />);
    await enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent("The code is invalid or expired.");
    expect(screen.getByLabelText("Six-digit code")).toHaveValue("001234");
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify and sign in" })).toBeEnabled());
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
