import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), changed: null as null | (() => void) }));
vi.mock("@/lib/services/model-preference-service", () => ({ ModelPreferenceService: mocks }));
vi.mock("@/lib/connections/gemini-runtime-configuration", () => ({
  onGeminiRuntimeConfigurationChanged: (callback: () => void) => { mocks.changed = callback; return () => { mocks.changed = null; }; },
}));
import { useOneModelPreference } from "@/lib/agent/use-one-model-preference";

const user = { uid: "owner-a", getIdToken: async () => "id-token" };
const preference = { user_id: "owner-a", effective_model: "old", choices: [{ model_id: "old" }, { model_id: "new" }] };
beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner(user.uid);
  mocks.get.mockResolvedValue(preference);
});

it("retires a Shared catalog when the effective AI connection changes and ignores its late read", async () => {
  const { result, unmount } = renderHook(() => useOneModelPreference(user, true));
  await waitFor(() => expect(result.current.modelPreference).toEqual(preference));
  let finish!: (value: unknown) => void;
  mocks.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => mocks.changed!());
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  expect(result.current.modelPreference).toBeNull();
  mocks.get.mockResolvedValueOnce(null);
  act(() => mocks.changed!());
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
  await act(async () => finish(preference));
  expect(result.current.modelPreference).toBeNull();
  unmount();
  expect(mocks.changed).toBeNull();
});

it("keeps the verified choice while saving, coalesces duplicate selection, and fences owner switch", async () => {
  const { result, rerender } = renderHook(({ owner }) => useOneModelPreference(owner, true), { initialProps: { owner: user } });
  await waitFor(() => expect(result.current.modelPreference).toEqual(preference));
  let finish!: (value: unknown) => void;
  mocks.set.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => { result.current.handleOneModelChange("new"); result.current.handleOneModelChange("new"); });
  await waitFor(() => expect(mocks.set).toHaveBeenCalledOnce());
  expect(result.current.modelPreference?.effective_model).toBe("old");
  expect(result.current.modelPreferenceSaving).toBe(true);
  publishValidatedAuthSessionOwner("owner-b");
  mocks.get.mockResolvedValue(null);
  rerender({ owner: { ...user, uid: "owner-b" } });
  await act(async () => finish({ ...preference, effective_model: "new" }));
  expect(result.current.modelPreference).toBeNull();
});

it("defers connection refresh until a pending model change settles without replay", async () => {
  const { result, unmount } = renderHook(() => useOneModelPreference(user, true));
  await waitFor(() => expect(result.current.modelPreference).toEqual(preference));
  let finish!: (value: unknown) => void;
  mocks.set.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => result.current.handleOneModelChange("new"));
  await waitFor(() => expect(mocks.set).toHaveBeenCalledOnce());
  act(() => { mocks.changed!(); mocks.changed!(); });
  expect(result.current.modelPreference).toBeNull();
  expect(result.current.modelPreferenceSaving).toBe(true);
  expect(mocks.get).toHaveBeenCalledOnce();
  act(() => result.current.handleOneModelChange("old"));
  const committed = { ...preference, effective_model: "new" };
  mocks.get.mockResolvedValue(committed);
  await act(async () => finish(committed));
  await waitFor(() => expect(result.current.modelPreference).toEqual(committed));
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(mocks.set).toHaveBeenCalledOnce();
  unmount();
});
