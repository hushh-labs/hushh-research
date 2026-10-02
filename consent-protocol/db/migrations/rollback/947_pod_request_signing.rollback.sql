-- Roll back dev-only migration 947 (pod request signing).
-- Pair with a hub that no longer verifies signatures: the latch is discarded, so
-- every row returns to the transitional Google ID token path. Signing keys are
-- public and re-derivable; the hub re-pulls them if 947 is applied again.
-- backend_metadata.signingKeyPull (a millisecond timestamp) is left in place on
-- purpose: it is inert without this code, and rewriting backend_metadata here
-- would trip the provision and erasure guards on rows those guards own.
BEGIN;

DROP TABLE IF EXISTS public.pod_request_nonces;

ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_pod_signing_key_check,
  DROP CONSTRAINT IF EXISTS personal_agent_registry_identity_mode_check;

ALTER TABLE public.personal_agent_registry
  DROP COLUMN IF EXISTS identity_mode,
  DROP COLUMN IF EXISTS pod_signing_key_id,
  DROP COLUMN IF EXISTS pod_signing_pubkey;

COMMIT;
