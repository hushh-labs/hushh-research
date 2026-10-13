ALTER TABLE advisor_investor_relationships
  DROP CONSTRAINT IF EXISTS advisor_investor_relationships_status_check;

ALTER TABLE advisor_investor_relationships
  ADD CONSTRAINT advisor_investor_relationships_status_check
  CHECK (
    status IN (
      'discovered',
      'request_pending',
      'approved',
      'revoked',
      'expired',
      'blocked',
      'disconnected'
    )
  );
