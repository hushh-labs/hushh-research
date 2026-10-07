"use client";

import { Preferences } from "@capacitor/preferences";
import {
  getLocalItem,
  removeLocalItem,
  setLocalItem,
} from "@/lib/utils/session-storage";

const ONBOARDING_MARKETING_SEEN_KEY = "onboarding_marketing_seen_v1";
const ONBOARDING_FORCE_INTRO_ONCE_KEY = "onboarding_force_intro_once_v1";
const acknowledgedReleases = new Set<string>();

export class OnboardingLocalService {
  /** Cosmetic release acknowledgement only, scoped to this owner and installation. */
  static async hasSeenRelease(ownerId: string, releaseId: string): Promise<boolean> {
    const key = this.releaseKey(ownerId, releaseId);
    if (acknowledgedReleases.has(key)) return true;
    if (getLocalItem(key) === "true") return true;
    try {
      return (await Preferences.get({ key })).value === "true";
    } catch {
      return false;
    }
  }

  static async markReleaseSeen(ownerId: string, releaseId: string): Promise<void> {
    const key = this.releaseKey(ownerId, releaseId);
    acknowledgedReleases.add(key);
    setLocalItem(key, "true");
    try {
      await Preferences.set({ key, value: "true" });
    } catch {
      // Cosmetic state can fall back to browser persistence.
    }
  }

  private static releaseKey(ownerId: string, releaseId: string): string {
    return `release_notice_seen_v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(releaseId)}`;
  }

  /** Erasure only: ordinary sign-out retains cosmetic acknowledgements. */
  static async clearReleaseNotices(ownerId: string): Promise<void> {
    const prefix = `release_notice_seen_v1:${encodeURIComponent(ownerId)}:`;
    for (const key of acknowledgedReleases) {
      if (key.startsWith(prefix)) acknowledgedReleases.delete(key);
    }
    try {
      const keys = Object.keys(window.localStorage).filter((key) => key.startsWith(prefix));
      keys.forEach((key) => removeLocalItem(key));
    } catch { /* Device storage may be unavailable. */ }
    try {
      const { keys } = await Preferences.keys();
      await Promise.allSettled(keys.filter((key) => key.startsWith(prefix)).map((key) => Preferences.remove({ key })));
    } catch { /* Erasure must still attempt the remaining local owners. */ }
  }

  /** Cosmetic Wallet introduction only; never grants setup, consent, or vault access. */
  static async hasSeenWalletIntroduction(ownerId: string): Promise<boolean> {
    const key = `wallet_introduction_seen_v1:${ownerId}`;
    if (getLocalItem(key) === "true") return true;
    try {
      const { value } = await Preferences.get({ key });
      if (value === "true") setLocalItem(key, "true");
      return value === "true";
    } catch {
      return false;
    }
  }

  static async markWalletIntroductionSeen(ownerId: string): Promise<void> {
    const key = `wallet_introduction_seen_v1:${ownerId}`;
    setLocalItem(key, "true");
    try {
      await Preferences.set({ key, value: "true" });
    } catch {
      // Browser fallback remains available when native preferences are unavailable.
    }
  }

  private static setLocalValue(key: string, value: string): void {
    setLocalItem(key, value);
  }

  private static getLocalValue(key: string): string | null {
    return getLocalItem(key);
  }

  private static removeLocalValue(key: string): void {
    removeLocalItem(key);
  }

  static async hasSeenMarketing(): Promise<boolean> {
    try {
      const { value } = await Preferences.get({ key: ONBOARDING_MARKETING_SEEN_KEY });
      return value === "true";
    } catch (error) {
      console.warn("[OnboardingLocalService] Failed to read local onboarding flag:", error);
      return false;
    }
  }

  static async markMarketingSeen(): Promise<void> {
    try {
      await Preferences.set({
        key: ONBOARDING_MARKETING_SEEN_KEY,
        value: "true",
      });
      this.setLocalValue(ONBOARDING_MARKETING_SEEN_KEY, "true");
    } catch (error) {
      console.warn("[OnboardingLocalService] Failed to persist local onboarding flag:", error);
    }
  }

  static async clearMarketingSeen(): Promise<void> {
    try {
      await Preferences.set({
        key: ONBOARDING_MARKETING_SEEN_KEY,
        value: "false",
      });
      await Preferences.remove({ key: ONBOARDING_MARKETING_SEEN_KEY });
      this.removeLocalValue(ONBOARDING_MARKETING_SEEN_KEY);
    } catch (error) {
      console.warn("[OnboardingLocalService] Failed to clear local onboarding flag:", error);
    }
  }

  static async markForceIntroOnce(): Promise<void> {
    try {
      await Preferences.set({
        key: ONBOARDING_FORCE_INTRO_ONCE_KEY,
        value: "true",
      });
      this.setLocalValue(ONBOARDING_FORCE_INTRO_ONCE_KEY, "true");
    } catch (error) {
      console.warn("[OnboardingLocalService] Failed to set force-intro flag:", error);
    }
  }

  static async consumeForceIntroOnce(): Promise<boolean> {
    const localValue = this.getLocalValue(ONBOARDING_FORCE_INTRO_ONCE_KEY);
    if (localValue === "true") {
      this.removeLocalValue(ONBOARDING_FORCE_INTRO_ONCE_KEY);
      return true;
    }

    try {
      const { value } = await Preferences.get({ key: ONBOARDING_FORCE_INTRO_ONCE_KEY });
      if (value !== "true") return false;
      await Preferences.remove({ key: ONBOARDING_FORCE_INTRO_ONCE_KEY });
      this.removeLocalValue(ONBOARDING_FORCE_INTRO_ONCE_KEY);
      return true;
    } catch (error) {
      console.warn("[OnboardingLocalService] Failed to read force-intro flag:", error);
      return false;
    }
  }
}
