BEGIN;

COMMENT ON TABLE one_location_nearby_presences IS
  'Encrypted, short-lived nearby check-in presence. Raw device GPS is request-memory-only; selected public-place anchors are encrypted and cleared on checkout or expiry.';

COMMENT ON COLUMN one_location_nearby_presences.anchor_cell_token IS
  'Six-hour server-keyed spatial candidate token. Exact radius membership is always rechecked against decrypted selected-place anchors.';

COMMIT;
