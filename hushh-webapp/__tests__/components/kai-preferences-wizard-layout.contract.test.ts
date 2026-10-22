import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKaiPreferencesWizard } from "@/components/kai/onboarding/use-kai-preferences-wizard";
import { useProfileFinancePreferences } from "@/components/profile/use-profile-finance-preferences";
import { projectNativeFinancePreferences } from "@/components/profile/native-finance-preferences";
import { validNativeFinancePath } from "@/lib/capacitor/native-drawers";
import { KaiProfileService, type KaiProfileV2 } from "@/lib/services/kai-profile-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";

const answers = { investment_horizon: "short_term", drawdown_response: "stay", volatility_preference: "moderate" } as const;
const profile = { preferences: answers } as KaiProfileV2;
afterEach(() => { vi.restoreAllMocks(); publishValidatedAuthSessionOwner(null); });

describe("Finance preferences shared web/native operation contracts", () => {
  it("keeps the active question when onboarding echoes its asynchronously saved initial answers", async () => {
    const { result, rerender } = renderHook(({ initial }) => useKaiPreferencesWizard({ mode: "onboarding",
      initialAnswers: initial, onComplete: vi.fn() }), { initialProps: { initial: { ...answers, investment_horizon: "short_term" as "short_term" | "long_term" } } });
    act(() => { result.current.handleSelect("long_term"); });
    await act(async () => { await result.current.handlePrimary(); });
    expect(result.current.step).toBe(1);
    rerender({ initial: { ...answers, investment_horizon: "long_term" } });
    expect(result.current.step).toBe(1);
    expect(result.current.answers.investment_horizon).toBe("long_term");
  });
  it("requires the same horizon confirmation for voice/native and submits one committed choice", async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useKaiPreferencesWizard({ mode: "edit", initialAnswers: answers, onComplete: save }));
    await act(async () => {
      const outcome = await resolveLocalOnboardingHandler("kai.setup.answer_horizon")!({ answer: "long_term" });
      expect(outcome.status).toBe("blocked");
    });
    expect(result.current.answers.investment_horizon).toBe("short_term");
    const projection = projectNativeFinancePreferences({ available: true, profile, loading: false, saving: false,
      error: null, notice: null, wizard: result.current, retry: async () => undefined });
    expect(validNativeFinancePath(projection.pages)).toBe(true);
    expect(projection.pages.map(page => page.id)).toEqual(["finance-preferences", "finance-anchor"]);
    expect(validNativeFinancePath([...projection.pages].reverse())).toBe(false);
    act(() => { projection.rows.get("finance-anchor-original")!(); });
    act(() => { result.current.applyHorizon(); });
    expect(result.current.answers.investment_horizon).toBe("long_term");
    await act(async () => { await result.current.handlePrimary(); });
    await act(async () => { await result.current.handlePrimary(); });
    let first!: Promise<void>, duplicate!: Promise<void>;
    act(() => { first = result.current.handlePrimary(); duplicate = result.current.handlePrimary(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ...answers, investment_horizon: "long_term", horizonAnchorChoice: "keep_original" });
    await act(async () => { finish(); await Promise.all([first, duplicate]); });
  });

  it("rejects old-visit selections and late owner reads instead of exposing another owner's preferences", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    let resolveOld!: (value: KaiProfileV2) => void;
    const old = new Promise<KaiProfileV2>(resolve => { resolveOld = resolve; });
    const read = vi.spyOn(KaiProfileService, "getProfile").mockImplementation(({ userId }) => userId === "owner-a" ? old : Promise.resolve(profile));
    const { result, rerender } = renderHook(({ owner }) => useProfileFinancePreferences({ userId: owner,
      vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-owner-token", canEdit: true }), { initialProps: { owner: "owner-a" } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const retired = result.current.wizard;
    publishValidatedAuthSessionOwner("owner-b"); rerender({ owner: "owner-b" });
    await waitFor(() => expect(result.current.profile).toBe(profile));
    act(() => { retired.handleSelect("long_term"); });
    await act(async () => { resolveOld({ preferences: { ...answers, investment_horizon: "long_term" } } as KaiProfileV2); await old; });
    expect(result.current.profile).toBe(profile);
    expect(result.current.wizard.answers.investment_horizon).toBe("short_term");
  });

  it("uses the confirmed save result without a second read that could misreport a committed write", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    const read = vi.spyOn(KaiProfileService, "getProfile").mockResolvedValueOnce(profile).mockRejectedValue(new Error("synthetic refresh failure"));
    const committed = { ...profile, updated_at: "2026-10-17T00:00:00Z" };
    const save = vi.spyOn(KaiProfileService, "savePreferences").mockResolvedValue(committed);
    const { result } = renderHook(() => useProfileFinancePreferences({ userId: "owner-a", vaultKey: "synthetic-key",
      vaultOwnerToken: "synthetic-owner-token", canEdit: true }));
    await waitFor(() => expect(result.current.profile).toBe(profile));
    await act(async () => { await result.current.wizard.handlePrimary(); });
    await act(async () => { await result.current.wizard.handlePrimary(); });
    await act(async () => { await result.current.wizard.handlePrimary(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.profile).toBe(committed);
    expect(result.current.notice).toBe("Preferences updated");
    expect(result.current.error).toBeNull();
    save.mockRejectedValueOnce(new Error("synthetic failed save"));
    await act(async () => { await result.current.wizard.handlePrimary(); });
    await act(async () => { await result.current.wizard.handlePrimary(); });
    await act(async () => {
      const outcome = await resolveLocalOnboardingHandler("kai.setup.answer_volatility")!({ answer: "moderate" });
      expect(outcome.status).toBe("failed");
      expect(outcome.summary).toBe("Preferences couldn't be saved. Please retry.");
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.error).toBe("Couldn't save preferences. Please retry.");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
