-- Phone possession transfers a binding, never an account or its information.
ALTER TABLE public.actor_identity_cache
 ADD COLUMN IF NOT EXISTS phone_binding_revision bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.advance_phone_binding_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF ROW(NEW.phone_number,NEW.phone_verified) IS DISTINCT FROM ROW(OLD.phone_number,OLD.phone_verified) THEN
  NEW.phone_binding_revision := OLD.phone_binding_revision + 1;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS phone_binding_revision ON public.actor_identity_cache;
CREATE TRIGGER phone_binding_revision BEFORE UPDATE ON public.actor_identity_cache
 FOR EACH ROW EXECUTE FUNCTION public.advance_phone_binding_revision();

CREATE TABLE IF NOT EXISTS public.account_phone_transfers (
 operation_id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
 previous_user_id text NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
 previous_revision bigint NOT NULL,
 requester_revision bigint NOT NULL DEFAULT 0,
 proof_identity_uid text NOT NULL,
 proof_generation bigint NOT NULL DEFAULT 0,
 proof_owner_id text NOT NULL,
 unlink_required boolean NOT NULL DEFAULT true,
 authority_project text NOT NULL,
 phone_digest text NOT NULL,
 proof_digest text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','committed','completed')),
 effect_state text CHECK(effect_state IN ('reserved','dispatched','uncertain','completed')),
 last_reconciled_at timestamptz,
 notice_dispatched_at timestamptz,
 notice_status text NOT NULL DEFAULT 'pending' CHECK(notice_status IN ('pending','dispatched','settled','uncertain')),
 mutation_id uuid,
 mutation_nonce uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 committed_at timestamptz,
 completed_at timestamptz,
 CHECK(user_id <> previous_user_id),
 CHECK(expires_at > created_at),
 CHECK(previous_revision >= 0 AND requester_revision >= 0 AND proof_generation >= 0),
 CHECK(phone_digest ~ '^hmac-sha256:[0-9a-f]{64}$' AND proof_digest ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS account_phone_transfers_owner ON public.account_phone_transfers(user_id,created_at);
CREATE TABLE IF NOT EXISTS public.account_phone_auth_fences (
 identity_hash text NOT NULL,
 phone_digest text NOT NULL,
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(identity_hash,phone_digest)
);
REVOKE ALL ON public.account_phone_auth_fences FROM PUBLIC;
COMMENT ON TABLE public.account_phone_auth_fences IS
 'Hash-only retired phone sign-in authority; independent of transfer workflow retention and account deletion. Google/Apple sign-in is unaffected.';
REVOKE ALL ON public.account_phone_transfers FROM PUBLIC;
COMMENT ON TABLE public.account_phone_transfers IS
 'Short-lived phone transfer workflow; no OTP, bearer, phone number or private account projection. Prepared intents expire after five minutes; settled workflow receipts are pruned after seven days. Erasure waits for committed provider work, then removes workflow receipts. Hash-only admission fences have independent retention.';
ALTER TABLE public.account_firebase_mutations DROP CONSTRAINT IF EXISTS account_firebase_mutations_purpose_check;
ALTER TABLE public.account_firebase_mutations ADD CONSTRAINT account_firebase_mutations_purpose_check
 CHECK(purpose IN ('display_name','welcome_marker','phone_unlink'));
SELECT public.install_account_deletion_write_guards();

-- Pending provider work owns its exact UID until settlement. Deletion takes
-- exclusive lifecycle barriers before reaching this guard; confirmation holds
-- their shared counterparts, so erasure and transfer cannot pass each other.
CREATE OR REPLACE FUNCTION public.guard_pending_phone_transfer_erasure()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.account_phone_transfers
  WHERE state='committed' AND (user_id=OLD.user_id OR previous_user_id=OLD.user_id OR proof_owner_id=OLD.user_id)) THEN
  RAISE EXCEPTION 'PHONE_TRANSFER_IN_PROGRESS' USING ERRCODE='23514';
 END IF;
 DELETE FROM public.account_phone_transfers WHERE proof_owner_id=OLD.user_id;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS pending_phone_transfer_erasure ON public.actor_profiles;
CREATE TRIGGER pending_phone_transfer_erasure BEFORE DELETE ON public.actor_profiles
 FOR EACH ROW EXECUTE FUNCTION public.guard_pending_phone_transfer_erasure();
