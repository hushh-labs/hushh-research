-- Recovery navigation is state, never account authority. No raw phone or proof.
CREATE TABLE IF NOT EXISTS public.account_phone_recovery_continuations (
 operation_id uuid PRIMARY KEY,
 requester_user_id text NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
 target_user_id text REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN ('recover','delete','revoke')),
 phone_digest text NOT NULL CHECK(phone_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
 binding_revision bigint,
 generation bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '15 minutes 1 second'),
 CHECK((target_user_id IS NULL AND binding_revision IS NULL AND generation IS NULL)
  OR (target_user_id IS NOT NULL AND binding_revision IS NOT NULL AND generation IS NOT NULL
      AND binding_revision>=0 AND generation>=0))
);
CREATE INDEX IF NOT EXISTS phone_recovery_requester ON public.account_phone_recovery_continuations(requester_user_id,expires_at);
CREATE INDEX IF NOT EXISTS phone_recovery_target ON public.account_phone_recovery_continuations(target_user_id);
CREATE INDEX IF NOT EXISTS phone_recovery_expiry ON public.account_phone_recovery_continuations(expires_at);
REVOKE ALL ON public.account_phone_recovery_continuations FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.account_device_actions (
 operation_id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
 device_id text NOT NULL CHECK(device_id ~ '^tdv_[A-Za-z0-9_-]{20,80}$'),
 continuation_id uuid REFERENCES public.account_phone_recovery_continuations(operation_id) ON DELETE SET NULL,
 phone_digest text NOT NULL CHECK(phone_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
 binding_revision bigint NOT NULL CHECK(binding_revision>=0),
 generation bigint NOT NULL CHECK(generation>=0),
 proof_event_digest text UNIQUE CHECK(proof_event_digest ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','cancelled','pending','completed','action_required')),
 pod_binding_version bigint CHECK(pod_binding_version>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 dispatched_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '5 minutes 1 second'),
 CHECK((state IN ('prepared','cancelled') AND proof_event_digest IS NULL AND dispatched_at IS NULL)
  OR (state NOT IN ('prepared','cancelled') AND proof_event_digest IS NOT NULL AND dispatched_at IS NOT NULL)),
 CHECK((state='completed')=(pod_binding_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS device_actions_owner ON public.account_device_actions(user_id,expires_at);
CREATE INDEX IF NOT EXISTS device_actions_expiry ON public.account_device_actions(expires_at);
REVOKE ALL ON public.account_device_actions FROM PUBLIC;
COMMENT ON TABLE public.account_device_actions IS
 'Own-device action admission only. Unique stable phone-proof event digests prevent replay. Five-minute prepared actions; completed receipts prune after seven days. Unknown dispatches never automatically replay and remain bounded per owner. Account deletion cascades metadata.';
SELECT public.install_account_deletion_write_guards();
