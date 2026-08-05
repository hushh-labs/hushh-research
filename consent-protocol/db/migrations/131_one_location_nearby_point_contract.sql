BEGIN;

-- This is a comment-only contract correction. Migration 126 named the
-- encrypted coordinate a selected-place anchor, while consent v2 stores the
-- fresh point captured when the owner confirms check-in. Existing v1 rows are
-- rejected and cleared by the application; no ciphertext is rewritten here.
COMMENT ON TABLE one_location_nearby_presences IS
  'Encrypted, short-lived nearby check-in presence. The final captured check-in point is encrypted and cleared on checkout or expiry; accuracy is request-memory-only.';

COMMENT ON COLUMN one_location_nearby_presences.anchor_cell_token IS
  'Six-hour server-keyed spatial candidate token. Exact radius membership is always rechecked against decrypted captured check-in points.';

COMMIT;
