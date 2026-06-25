-- 073_crm_registry_mulesoft_simplify.sql
--
-- MuleSoft handoff refinements to the enterprise CRM registry, per the
-- connector team's review of the 072 shape:
--
--   1) KDF parameters (salt + iteration count + algorithm) are CONSTANT across
--      every MuleSoft-published CRM, so storing them on each row is redundant.
--      They now live in connector config (CONNECTOR_KDF_SALT /
--      CONNECTOR_KDF_ITERATIONS); the row columns become OPTIONAL overrides.
--      The credential-shape CHECK is relaxed accordingly: a PBKDF2-CBC row must
--      still carry both ciphertext blobs, but no longer must repeat salt/iters.
--
--   2) Delete uses a DIFFERENT Salesforce endpoint path than read/create/update,
--      so add `crm_delete_endpoint`. The existing `crm_mcp_endpoint` continues to
--      serve schema/create/read/update; delete (when enabled) uses the new column.
--
-- Security posture is UNCHANGED and still fail-closed:
--   * Credentials remain CIPHERTEXT-ONLY at rest — no plaintext column is, or
--     ever will be, introduced. The blob columns hold base64(iv||ciphertext).
--   * The PBKDF2 password is the connector secret (CONNECTOR_SECRETS_KEY), held
--     in the environment, never in the row. UAT may use a shared value; prod
--     must use a real high-entropy 256-bit key (the cipher/iteration count do
--     not save a weak password).
--   * User-data encryption is untouched and stays AES-256-GCM.

BEGIN;

-- 1) Delete endpoint (different Salesforce path than the CRUD-read endpoint).
ALTER TABLE enterprise_crm_registry
  ADD COLUMN IF NOT EXISTS crm_delete_endpoint TEXT;

-- 2) Relax the credential-shape guard: PBKDF2-CBC rows must carry both blobs,
--    but salt/iterations are now optional (resolved from connector config when
--    the row omits them). GCM rows are unchanged.
ALTER TABLE enterprise_crm_registry DROP CONSTRAINT IF EXISTS crm_registry_credential_shape;
ALTER TABLE enterprise_crm_registry ADD CONSTRAINT crm_registry_credential_shape CHECK (
  (encryption_algorithm = 'aes-256-gcm'
     AND crm_client_id_ciphertext     IS NOT NULL
     AND crm_client_secret_ciphertext IS NOT NULL)
  OR
  (encryption_algorithm = 'pbkdf2-hmacsha256-aes256-cbc'
     AND crm_client_id_blob     IS NOT NULL
     AND crm_client_secret_blob IS NOT NULL)
);

COMMIT;
