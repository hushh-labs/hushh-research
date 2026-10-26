import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { evaluateKaiActionAvailability, getKaiActionById } from "@/lib/kai/actions/kai-action-gateway";
import { BackgroundShareToggle } from "@/app/one/location/background-share-toggle";
const native = vi.hoisted(() => ({ value: true }));
vi.mock("@capacitor/core", async (original) => { const actual = await original<typeof import("@capacitor/core")>(); return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => native.value } }; });
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: vi.fn() } }));

describe("BackgroundShareToggle", () => {
  it("requests OS access only after visible disclosure acceptance", async () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn().mockResolvedValue({ background: "available" });
    render(<BackgroundShareToggle enabled={false} onEnabledChange={onEnabledChange} requestAlwaysAuthorization={requestAlways} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("dialog")).toHaveTextContent(/collects your location in the background/);
    expect(requestAlways).not.toHaveBeenCalled();
    expect(onEnabledChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    expect(requestAlways).toHaveBeenCalledTimes(1);
  });

  it("stays off when background access is denied", async () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn().mockResolvedValue({ background: "foreground-only" });
    render(<BackgroundShareToggle enabled={false} onEnabledChange={onEnabledChange} requestAlwaysAuthorization={requestAlways} />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(requestAlways).toHaveBeenCalledTimes(1));
    expect(onEnabledChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("switch")).not.toBeChecked();
  });

  it.each(["cancel", "escape", "owner change"])("ignores a late permission result after %s", async (dismiss) => {
    let resolve!: (permission: { background: string }) => void;
    const permission = new Promise<{ background: string }>((done) => { resolve = done; });
    const onEnabledChange = vi.fn();
    const { rerender } = render(<BackgroundShareToggle key="owner-a" enabled={false} onEnabledChange={onEnabledChange} requestAlwaysAuthorization={() => permission} />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    if (dismiss === "cancel") fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    else if (dismiss === "escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    else rerender(<BackgroundShareToggle key="owner-b" enabled={false} onEnabledChange={onEnabledChange} requestAlwaysAuthorization={() => permission} />);
    resolve({ background: "available" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onEnabledChange).not.toHaveBeenCalled();
  });

  it("turns off immediately without requesting OS access", () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn();
    render(<BackgroundShareToggle enabled onEnabledChange={onEnabledChange} requestAlwaysAuthorization={requestAlways} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
    expect(requestAlways).not.toHaveBeenCalled();
  });

  it("does not expose the native-only upgrade on web", () => {
    native.value = false;
    const { unmount } = render(<BackgroundShareToggle enabled={false} onEnabledChange={vi.fn()} requestAlwaysAuthorization={vi.fn()} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    unmount(); native.value = true;
  });
});

describe("background permission authority", () => {
  it.each(["location.background_review", "location.background_accept", "location.background_cancel"])("keeps %s manual and unavailable to Siri", (id) => {
    const action = getKaiActionById(id);
    expect(action).toBeTruthy();
    expect(action?.siri_mode).toBe("unsupported");
    expect(evaluateKaiActionAvailability({ action: action! })).toMatchObject({ status: "manual_only" });
    expect(evaluateKaiActionAvailability({ action: action! }).reason).toContain("on-screen control");
  });
});
