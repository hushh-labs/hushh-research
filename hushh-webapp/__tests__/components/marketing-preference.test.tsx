import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useMarketingPreference } from "@/components/account/use-marketing-preference";
import { MarketingPreferencePanel } from "@/components/account/marketing-preference-panel";

const mocks = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn(), toast: vi.fn(), dismiss: vi.fn(), native: false, active: true, epoch: 0 }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getFirebaseIdTokenForOwner: mocks.token, apiFetch: mocks.fetch } }));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => mocks.native } };
});
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativePrivacyObservation: () => ({ epoch: mocks.epoch, state: { generation: mocks.epoch, appIsActive: mocks.active, shielded: !mocks.active } }), subscribeNativePrivacyObservation: () => () => undefined }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: mocks.toast, dismiss: mocks.dismiss } }));
const empty = { enabled: false, frequency: "weekly", revision: 0, generation: null,
  disclosureVersion: "one-email-updates-v1", consentAt: null, chosenAt: null };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function Form() { return <MarketingPreferencePanel model={useMarketingPreference("owner", "setup")} />; }
beforeEach(() => {
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner");
  mocks.native = false; mocks.active = true; mocks.epoch = 0;
  mocks.toast.mockReset().mockReturnValue(55); mocks.dismiss.mockReset();
  mocks.token.mockReset().mockResolvedValue("fixture-token");
  mocks.fetch.mockReset().mockImplementation(async () => response(empty));
});
afterEach(() => { cleanup(); publishValidatedAuthSessionOwner(null); });

describe("explicit email preference", () => {
  it("loads the real saved choice, stages edits, and saves only after a physical submit", async () => {
    render(<Form />);
    const toggle = await screen.findByRole("switch");
    expect(toggle).not.toBeChecked();
    expect(mocks.fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    fireEvent.click(toggle);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    mocks.fetch.mockResolvedValueOnce(response({ ...empty, enabled: true, revision: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Save email preference" }));
    await screen.findByText("Email preference saved.");
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({ enabled: true, frequency: "weekly",
      expectedRevision: 0, disclosureVersion: "one-email-updates-v1", surface: "setup" });
  });

  it("cannot save a fabricated default while a read is pending or failed", async () => {
    let reject!: (reason: Error) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const { result } = renderHook(() => useMarketingPreference("owner", "account"));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    await act(() => result.current.save(true, "daily"));
    expect(mocks.fetch).toHaveBeenCalledOnce();
    await act(async () => { reject(new Error("offline")); });
    expect(result.current.value).toBeNull();
    await act(() => result.current.save(false, "weekly"));
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each(["unmount", "same-owner-relogin", "other-owner", "native-background"])("retires a captured Save after %s", async (departure) => {
    const view = renderHook(({ owner }) => useMarketingPreference(owner, "account"), { initialProps: { owner: "owner" } });
    await waitFor(() => expect(view.result.current.value).not.toBeNull());
    const old = view.result.current;
    if (departure === "unmount") view.unmount();
    if (departure === "same-owner-relogin") {
      publishValidatedAuthSessionOwner(null); publishValidatedAuthSessionOwner("owner");
      view.rerender({ owner: "owner" });
      await waitFor(() => expect(view.result.current.value).not.toBeNull());
    }
    if (departure === "other-owner") {
      publishValidatedAuthSessionOwner("other"); view.rerender({ owner: "other" });
      await waitFor(() => expect(view.result.current.value).not.toBeNull());
    }
    if (departure === "native-background") { mocks.native = true; mocks.active = false; }
    const dispatched = mocks.fetch.mock.calls.length, tokens = mocks.token.mock.calls.length;
    await act(() => old.save(true, "daily"));
    expect(mocks.fetch).toHaveBeenCalledTimes(dispatched);
    expect(mocks.token).toHaveBeenCalledTimes(tokens);
  });

  it.each(["verified_email_required", "preference_conflict", "uncertain"])("has safe, distinct recovery for %s", async (code) => {
    render(<Form />);
    fireEvent.click(await screen.findByRole("switch"));
    mocks.fetch.mockResolvedValueOnce(response({ detail: { code } }, code === "uncertain" ? 503 : 409));
    fireEvent.click(screen.getByRole("button", { name: "Save email preference" }));
    const alert = await screen.findByRole("alert");
    if (code === "verified_email_required") {
      expect(alert).toHaveTextContent("Verify your account email");
      expect(screen.getByRole("switch")).toBeInTheDocument();
    } else {
      expect(alert).toHaveTextContent("Refresh before choosing again");
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.getByRole("button", { name: "Retry email preference" })).toBeInTheDocument();
    }
    expect(mocks.fetch.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  });

  it("retires a native save across background/resume during token acquisition without stranding busy", async () => {
    mocks.native = true;
    const { result } = renderHook(() => useMarketingPreference("owner", "account"));
    await waitFor(() => expect(result.current.value).not.toBeNull());
    let release!: (token: string) => void;
    mocks.token.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    let saving!: Promise<void>;
    act(() => { saving = result.current.save(true, "daily"); });
    mocks.active = false; mocks.epoch++;
    mocks.active = true;
    await act(async () => { release("fixture-token"); await saving; });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(false);
    expect(result.current.value).toBeNull();
    expect(mocks.toast.mock.calls[0][1].isCurrent()).toBe(false);
  });

  it("dismisses a retired loading toast and suppresses its late replacement-session verdict", async () => {
    mocks.toast.mockReturnValueOnce(Object.assign(55, { unwrap: async () => undefined }));
    const view = renderHook(() => useMarketingPreference("owner", "account"));
    await waitFor(() => expect(view.result.current.value).not.toBeNull());
    let release!: (value: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    let saving!: Promise<void>;
    act(() => { saving = view.result.current.save(true, "weekly"); });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    view.unmount(); publishValidatedAuthSessionOwner("replacement");
    expect(mocks.dismiss).toHaveBeenCalledWith(55);
    await act(async () => { release(response({ ...empty, enabled: true, revision: 1 })); await saving; });
    expect(mocks.toast.mock.calls[0][1].isCurrent()).toBe(false);
  });
});
