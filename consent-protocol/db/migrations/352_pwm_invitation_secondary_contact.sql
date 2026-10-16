-- One invitation can be claimed through either verified contact supplied by the inviter.
ALTER TABLE pwm_claim_invitations
    ADD COLUMN IF NOT EXISTS secondary_contact_commitment TEXT;
COMMENT ON COLUMN pwm_claim_invitations.secondary_contact_commitment IS
    'Optional keyed commitment for a second verified recipient contact; no raw contact is stored.';
