-- Reverse 275: reactivate settings version 1, retire version 2.
--
-- VERSION-PRESERVING, NOT DELETING. This mirrors the discipline migration
-- 270 documented for every settings transition in this table: a version
-- once created is never removed, only retired or reactivated by moving
-- `retired_at`. Version 2's row -- its milestones, its weekly_schedule, its
-- activated_at/retired_at timestamps -- stays in the table permanently as
-- the historical record of what was live and when. This also keeps
-- referential sense for anything written while it was active:
-- `one_referral_score_events.settings_version` and any future column like it
-- still point at a real, readable row instead of a dangling version number.
--
-- RESTORING SETTINGS IS NOT REVERSING REWARD EFFECTS. This script changes
-- exactly one thing: which `one_referral_program_settings` row is the
-- single CURRENT one. It does not touch, and cannot touch by design,
-- anything a user already earned while version 2 was active:
--
--   * `one_referral_score_events` rows written under version 2 keep their
--     points and their `settings_version = 2` forever. Rolling back which
--     version is current does not re-score or delete a single ledger entry.
--   * `one_referral_milestone_entitlements` rows -- a real voucher/earbuds/
--     AirPods/iPhone entitlement a referrer crossed a threshold for while
--     v2 was live -- are equally untouched. "Earned totals are never
--     recomputed under a version that did not exist when they were earned"
--     (migration 270's own words) applies exactly as much in reverse: an
--     entitlement earned under v2 does not un-earn itself because v2 is no
--     longer the current version.
--   * If this rollback runs AFTER entitlements have been issued under v2,
--     those entitlement rows are exactly as present and exactly as correct
--     afterward as before -- verify with
--     `SELECT * FROM one_referral_milestone_entitlements WHERE
--     earned_at >= '<v2 activated_at>'` before and after to see this
--     directly. Making v1 current again only changes what a FUTURE
--     threshold crossing reads; it does not and cannot reach backward.
--
-- Reversing an actual reward (clawing back an entitlement, cancelling a
-- fulfillment record) is a separate, explicit operational action on
-- `one_referral_milestone_entitlements` / `one_referral_fulfillment_records`
-- directly -- never a side effect of this settings rollback, and not
-- something this file does.
--
-- GUARDED AND SERIALIZED, same as the forward migration: locks both rows
-- before reading either, is an idempotent no-op if already rolled back,
-- refuses with no write at all if the starting state is not exactly
-- "version 2 active, version 1 retired", and asserts exactly one active
-- version remains before commit.

BEGIN;

DO $rollback_275$
DECLARE
  v1_row one_referral_program_settings%ROWTYPE;
  v1_found BOOLEAN;
  v2_row one_referral_program_settings%ROWTYPE;
  v2_found BOOLEAN;
  active_count INTEGER;
BEGIN
  PERFORM 1 FROM one_referral_program_settings WHERE version IN (1, 2) FOR UPDATE;

  SELECT * INTO v1_row FROM one_referral_program_settings WHERE version = 1;
  v1_found := FOUND;
  SELECT * INTO v2_row FROM one_referral_program_settings WHERE version = 2;
  v2_found := FOUND;

  IF NOT v1_found THEN
    RAISE EXCEPTION 'rollback 275: version 1 does not exist; nothing to reactivate';
  END IF;

  IF v2_found
     AND v1_row.activated_at IS NOT NULL AND v1_row.retired_at IS NULL
     AND v2_row.retired_at IS NOT NULL
  THEN
    -- Already rolled back: version 1 active, version 2 retired. Idempotent
    -- success -- a replayed rollback changes nothing further.
    RAISE NOTICE 'rollback 275: version 1 already active and version 2 already retired; idempotent no-op';

  ELSIF v2_found
        AND v2_row.activated_at IS NOT NULL AND v2_row.retired_at IS NULL
        AND v1_row.retired_at IS NOT NULL
  THEN
    -- Expected forward state: version 2 is current, version 1 is retired.
    -- Reverse exactly that, preserving both rows.
    UPDATE one_referral_program_settings SET retired_at = NOW() WHERE version = 2;
    UPDATE one_referral_program_settings SET retired_at = NULL WHERE version = 1;

  ELSE
    RAISE EXCEPTION 'rollback 275: unexpected starting state (version 1 activated_at=%, retired_at=%; version 2 exists=%, activated_at=%, retired_at=%); refusing to guess which version should be current',
      v1_row.activated_at, v1_row.retired_at, v2_found, v2_row.activated_at, v2_row.retired_at;
  END IF;

  SELECT COUNT(*) INTO active_count
    FROM one_referral_program_settings
   WHERE activated_at IS NOT NULL AND retired_at IS NULL;
  IF active_count <> 1 THEN
    RAISE EXCEPTION 'rollback 275: invariant violated; expected exactly one active settings version after rollback, found %',
      active_count;
  END IF;
END
$rollback_275$;

COMMIT;
