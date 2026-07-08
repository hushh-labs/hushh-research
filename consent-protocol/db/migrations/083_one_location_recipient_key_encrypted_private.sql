BEGIN;

-- Cross-device consistent One Location recipient key.
--
-- The recipient's ECDH private key was device-bound (held only in the browser /
-- WKWebView on the device that registered it). Because the backend keeps a single
-- active key per user, logging the same account into a second device rotated the
-- first device's key out, so the other device could no longer decrypt shares
-- ("Recipient key unavailable for this location share.").
--
-- Fix: allow the client to store the private key encrypted with the user's vault
-- key (AES-256-GCM) so every device can fetch + decrypt the SAME keypair after
-- vault unlock. The server only ever holds this opaque ciphertext — it never sees
-- the plaintext private key (same trust model as pkm_data).
ALTER TABLE one_location_recipient_keys
  ADD COLUMN IF NOT EXISTS encrypted_private_key_jwk JSONB;

COMMENT ON COLUMN one_location_recipient_keys.encrypted_private_key_jwk IS
  'Opaque client-encrypted (vault-key AES-256-GCM) private key JWK blob {ciphertext,iv,tag,algorithm}. Server stores/echoes verbatim; never decrypted server-side. Enables cross-device key recovery. NULL for legacy device-bound keys.';

COMMIT;
