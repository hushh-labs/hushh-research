-- 072_crm_registry_mulesoft_pbkdf2_cbc.sql
--
-- Add MuleSoft-native credential encryption to the enterprise CRM registry so
-- the MuleSoft team can self-publish CRM rows with their built-in tooling.
--
-- Migration 071 stores credentials as an AES-256-GCM envelope (ciphertext + iv
-- + tag, three columns each) — the scheme Hushh uses for user data. MuleSoft's
-- JCE Decrypt module instead produces PBKDF2-HMAC-SHA256 + AES-256-CBC (FIPS)
-- output as a single base64 blob with a shared salt + iteration count. This
-- migration adds that interop shape ALONGSIDE the GCM columns; the existing
-- `encryption_algorithm` column is the discriminator the repository branches on.
--
-- User-data encryption is unaffected and stays AES-256-GCM. Credentials remain
-- ciphertext-only at rest in every shape — no plaintext column is introduced.

BEGIN;

-- 1) GCM envelope columns become nullable: a PBKDF2-CBC row leaves them NULL.
ALTER TABLE enterprise_crm_registry ALTER COLUMN crm_client_id_ciphertext DROP NOT NULL;
ALTER TABLE enterprise_crm_registry ALTER COLUMN crm_client_id_iv DROP NOT NULL;
ALTER TABLE enterprise_crm_registry ALTER COLUMN crm_client_id_tag DROP NOT NULL;
ALTER TABLE enterprise_crm_registry ALTER COLUMN crm_client_secret_ciphertext DROP NOT NULL;
ALTER TABLE enterprise_crm_registry ALTER COLUMN crm_client_secret_iv DROP NOT NULL;
ALTER TABLE enterprise_crm_registry ALTER COLUMN crm_client_secret_tag DROP NOT NULL;

-- 2) PBKDF2-AES256-CBC single-blob columns: base64 of (iv || ciphertext),
--    matching MuleSoft JCE output. Ciphertext-only — never plaintext.
ALTER TABLE enterprise_crm_registry ADD COLUMN IF NOT EXISTS crm_client_id_blob     TEXT;
ALTER TABLE enterprise_crm_registry ADD COLUMN IF NOT EXISTS crm_client_secret_blob TEXT;

-- 3) Non-secret KDF parameters. The salt is not a secret; the derived key never
--    leaves the connector-key custody. The connector password lives in the
--    environment (CONNECTOR_SECRETS_KEY), never in the row.
ALTER TABLE enterprise_crm_registry ADD COLUMN IF NOT EXISTS kdf_salt       TEXT;
ALTER TABLE enterprise_crm_registry ADD COLUMN IF NOT EXISTS kdf_iterations INTEGER;

-- 4) Guard: every row must carry credentials in EXACTLY one shape, matching its
--    declared encryption_algorithm. Prevents half-populated / mismatched rows.
ALTER TABLE enterprise_crm_registry DROP CONSTRAINT IF EXISTS crm_registry_credential_shape;
ALTER TABLE enterprise_crm_registry ADD CONSTRAINT crm_registry_credential_shape CHECK (
  (encryption_algorithm = 'aes-256-gcm'
     AND crm_client_id_ciphertext     IS NOT NULL
     AND crm_client_secret_ciphertext IS NOT NULL)
  OR
  (encryption_algorithm = 'pbkdf2-hmacsha256-aes256-cbc'
     AND crm_client_id_blob     IS NOT NULL
     AND crm_client_secret_blob IS NOT NULL
     AND kdf_salt               IS NOT NULL
     AND kdf_iterations         IS NOT NULL)
);

COMMIT;
