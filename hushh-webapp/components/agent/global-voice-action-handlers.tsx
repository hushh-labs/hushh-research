"use client";

/**
 * Voice actions that belong to the person's session rather than to any one
 * screen.
 *
 * Every other local handler in the app is registered by the page that owns it
 * (see `app/one/location/page.tsx`), which is right for a verb that only makes
 * sense while you are standing on that screen: "approve this request" has no
 * meaning off Location. Signing out is not that kind of verb. Someone says
 * "log me out" from wherever they happen to be, and until this component
 * existed the answer depended on which tab was open -- `profile.sign_out` is a
 * `local_handler`, and `requireMountedLocalHandlers`
 * (lib/voice/screen-context-builder.ts) drops any local handler that is not
 * mounted right now, so the action was only ever offered on Profile.
 *
 * Mounting here, inside `AuthProvider` and above the route tree, is what makes
 * the action true everywhere it is offered. The reserved global segment in
 * `screen-context-builder.ts` is the other half: it puts the id in front of the
 * model regardless of screen. Both are required -- a global slot for an
 * unmounted handler still gets filtered out, and a mounted handler nobody is
 * told about is never called.
 */

import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";

export function GlobalVoiceActionHandlers() {
  const router = useRouter();
  const { user, signOut } = useAuth();

  useLocalOnboardingActionHandler(
    "profile.sign_out",
    async () => {
      try {
        await signOut();
      } catch (error) {
        // The person asked to end their session and it did not end. Saying so
        // is the whole point of the `failed` status: a silent catch here would
        // return "Signed out." while they stayed signed in, which is the
        // failure mode that makes a voice agent untrustworthy.
        console.error("Voice sign out error:", error);
        return {
          status: "failed" as const,
          summary: "I could not sign you out. Please try from Profile.",
        };
      }
      router.push(ROUTES.HOME);
      return { status: "succeeded" as const, summary: "Signed out." };
    },
    // Not registered while signed out, so the action drops out of
    // available_action_ids instead of being offered and then refused by its
    // own auth_signed_in guard.
    { enabled: Boolean(user) },
  );

  return null;
}
