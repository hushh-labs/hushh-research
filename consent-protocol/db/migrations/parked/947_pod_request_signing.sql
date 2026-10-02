-- Dev-only: cloud-neutral pod-to-hub request signing
-- (docs/reference/architecture/byoc-azure.md, "Identity between agent and hub").
--
-- The pod signs every hub request with an Ed25519 key derived from its own X25519
-- key. The hub records the public half only from a GET it initiates itself, in the
-- same write as pod_pubkey, so the signing key can never outlive or precede the pod
-- key it was published with. identity_mode='signed' is a one-way latch: once a row
-- has presented a valid signature, a Google-only request from it is refused.
-- pod_request_nonces makes every signature single-use within its 90-second window.
BEGIN;

ALTER TABLE public.personal_agent_registry
  ADD COLUMN IF NOT EXISTS pod_signing_pubkey text,
  ADD COLUMN IF NOT EXISTS pod_signing_key_id text,
  ADD COLUMN IF NOT EXISTS identity_mode text;

ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_pod_signing_key_check,
  DROP CONSTRAINT IF EXISTS personal_agent_registry_identity_mode_check;

ALTER TABLE public.personal_agent_registry
  ADD CONSTRAINT personal_agent_registry_pod_signing_key_check CHECK (
    (pod_signing_pubkey IS NULL) = (pod_signing_key_id IS NULL)
    AND (pod_signing_pubkey IS NULL OR pod_pubkey IS NOT NULL)
    AND (pod_signing_pubkey IS NULL OR pod_signing_pubkey ~ '^[A-Za-z0-9+/]{43}=$')
    AND (pod_signing_key_id IS NULL OR pod_signing_key_id ~ '^pods_[0-9a-f]{32}$')
  ),
  ADD CONSTRAINT personal_agent_registry_identity_mode_check CHECK (
    identity_mode IS NULL OR identity_mode = 'signed'
  );

CREATE TABLE IF NOT EXISTS public.pod_request_nonces (
  kid text NOT NULL CHECK (kid ~ '^pods_[0-9a-f]{32}$'),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kid, nonce)
);

CREATE INDEX IF NOT EXISTS pod_request_nonces_expires_at_idx
  ON public.pod_request_nonces (expires_at);

COMMENT ON COLUMN public.personal_agent_registry.pod_signing_pubkey IS
  'Standard base64 raw Ed25519 public key the pod signs hub requests with; recorded only from a hub-initiated GET to backend_metadata.url, bound to pod_pubkey.';
COMMENT ON COLUMN public.personal_agent_registry.pod_signing_key_id IS
  'pods_ + 32 hex of SHA-256 over pod_signing_pubkey; the kid a signed request names.';
COMMENT ON COLUMN public.personal_agent_registry.identity_mode IS
  'NULL until the row first presents a valid signature, then signed (one-way): Google-only requests are refused afterwards.';
COMMENT ON TABLE public.pod_request_nonces IS
  'Single-use (kid, nonce) markers for signed pod requests. No owner column; rows expire about 120 s after their signing time and are pruned by the verifier.';

COMMIT;
