-- Data-preserving rollback: disable the native Picker feature in configuration
-- and restore the prior application revision. Do not drop attempts, sessions,
-- catalog sources or encryption metadata; a late provider redirect must remain
-- unable to recreate a removed application flow.
BEGIN;
SELECT 1;
COMMIT;
