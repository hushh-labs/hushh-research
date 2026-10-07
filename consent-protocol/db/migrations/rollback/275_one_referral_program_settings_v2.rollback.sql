-- Reverse 275: retire settings version 2 and reactivate version 1.
--
-- Symmetric with the forward migration: no table, column, or constraint
-- changed, only which `one_referral_program_settings` row is the single
-- active one. Any points, milestones, or streak credit already earned under
-- version 2 is untouched -- those live on `one_referral_score_events` and
-- `one_referral_milestone_entitlements`, keyed by what was true when they
-- were earned, never recomputed from the currently active version.

BEGIN;

DELETE FROM one_referral_program_settings WHERE version = 2;

UPDATE one_referral_program_settings
   SET retired_at = NULL
 WHERE version = 1
   AND activated_at IS NOT NULL;

COMMIT;
