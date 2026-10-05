/**
 * Isolated-fixture stand-in for `@/lib/firebase/auth-context`.
 *
 * Aliased in ONLY for the `referrals-panel-gamification` layout-spec build
 * (see e2e/referrals-panel-gamification.layout.spec.ts). Never reaches the
 * real app bundle. Supplies the one thing ReferralsPanel reads off the real
 * hook -- a signed-in `user` with `getIdToken()` -- without touching Firebase.
 */
// Module-level, not per-call: ReferralsPanel's effects depend on `user` by
// reference (the real hook keeps it stable via useState), so a fresh object
// literal on every render would retrigger every effect that reads it on
// every render -- an infinite re-fetch loop, not a stale-auth bug.
const FIXTURE_USER = {
  uid: "fixture-viewer",
  getIdToken: async () => "fixture-id-token",
};

export function useAuth() {
  return { user: FIXTURE_USER };
}
