BEGIN;

-- Roll back migration 137.
--
DROP TABLE IF EXISTS ria_claim_dossiers;

COMMIT;
