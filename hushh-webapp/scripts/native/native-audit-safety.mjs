const DESTRUCTIVE_AUDIT_ENV = "HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT";

/**
 * Cold route/UI audits reset an emulator or simulator and load a governed test
 * fixture. They are deliberately not a continuity harness for a live session.
 */
export function assertDestructiveNativeAuditAllowed() {
  if (process.env[DESTRUCTIVE_AUDIT_ENV] === "true") return;
  throw new Error(
    `${DESTRUCTIVE_AUDIT_ENV}=true is required for a destructive cold-start native audit. It resets app state and may inject the reviewer fixture, so it cannot prove vault or route continuity. Use ios:continuity:local or android:continuity:local for a normal-session rehearsal.`,
  );
}
