-- Phone-proven deletion of the account holding a verified number. Admission
-- state only: no raw phone, proof, Firebase identity, email or provider data.
CREATE TABLE IF NOT EXISTS public.account_phone_linked_deletions (
 operation_id uuid PRIMARY KEY,
 requester_user_id text REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
 requester_hash text NOT NULL CHECK(requester_hash ~ '^sha256:[0-9a-f]{64}$'),
 target_user_id text REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
 target_hash text CHECK(target_hash ~ '^sha256:[0-9a-f]{64}$'),
 phone_digest text NOT NULL CHECK(phone_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
 binding_revision bigint CHECK(binding_revision>=0),
 generation bigint CHECK(generation>=0),
 transport text NOT NULL CHECK(transport IN ('sms','configured_test')),
 proof_event_digest text UNIQUE CHECK(proof_event_digest ~ '^[0-9a-f]{64}$'),
 failed_proof_count integer NOT NULL DEFAULT 0 CHECK(failed_proof_count BETWEEN 0 AND 5),
 state text NOT NULL DEFAULT 'prepared'
  CHECK(state IN ('prepared','cancelled','pending','admitted','refused','action_required')),
 result_code text CHECK(result_code ~ '^[A-Z][A-Z_]{2,63}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 dispatched_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '5 minutes 1 second'),
 -- A target is recorded only when a live verified holder existed at preparation.
 CHECK((target_hash IS NULL)=(binding_revision IS NULL) AND (target_hash IS NULL)=(generation IS NULL)),
 CHECK((proof_event_digest IS NULL)=(dispatched_at IS NULL)),
 CHECK(state NOT IN ('pending','admitted','action_required')
  OR (proof_event_digest IS NOT NULL AND target_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS phone_linked_deletions_requester
 ON public.account_phone_linked_deletions(requester_hash,created_at);
CREATE INDEX IF NOT EXISTS phone_linked_deletions_requester_user
 ON public.account_phone_linked_deletions(requester_user_id);
CREATE INDEX IF NOT EXISTS phone_linked_deletions_target
 ON public.account_phone_linked_deletions(target_user_id);
CREATE INDEX IF NOT EXISTS phone_linked_deletions_expiry
 ON public.account_phone_linked_deletions(expires_at);
REVOKE ALL ON public.account_phone_linked_deletions FROM PUBLIC;
COMMENT ON TABLE public.account_phone_linked_deletions IS
 'Phone-proven deletion admission. A fresh proof of the number authorizes the existing full-account erasure of its current verified holder; unique proof event digests prevent replay. Prepared rows are opaque and live five minutes; terminal receipts prune after 90 days. Erasure of either account removes its receipts.';
SELECT public.install_account_deletion_write_guards();
