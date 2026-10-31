-- Dev only: retain exact provider revocation outcomes without rewriting migration 949.
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_erasure_owner_access_checkpoint(
  reservation jsonb, checkpoint jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  snapshot jsonb := reservation->'registrySnapshot';
  agent jsonb := checkpoint->'agentErased';
  resume jsonb := checkpoint->'resume';
BEGIN
  -- Types first, each on its own: a jsonb operator on the wrong type raises.
  IF jsonb_typeof(checkpoint) IS DISTINCT FROM 'object'
     OR jsonb_typeof(agent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(resume) IS DISTINCT FROM 'object'
     OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF checkpoint - ARRAY['agentErased','resume'] <> '{}'::jsonb
     OR pg_column_size(checkpoint) > 8192
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR reservation->>'version' IS DISTINCT FROM '1'
     OR snapshot->>'user_id' IS DISTINCT FROM reservation->>'ownerId'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
     OR snapshot->'backend_metadata' ? 'upgradeLease'
  THEN RETURN false; END IF;
  -- What revocation needs without reading the agent: the setup nonce, nothing else.
  IF resume - ARRAY['setupNonce'] <> '{}'::jsonb
     OR jsonb_typeof(resume->'setupNonce') IS DISTINCT FROM 'string'
     OR resume->>'setupNonce' !~ '^[0-9a-f]{16}$' THEN RETURN false; END IF;
  -- The pod's own confirmation, bound to this attempt and the recorded incarnation.
  IF agent - ARRAY['status','erased','hushhId','attemptId','service','serviceUid','revision',
       'deleted','alreadyAbsent','records',
       'providerRevoked','providerUnconfirmed','providerUnavailable','providerCoverage'] <> '{}'::jsonb
     OR agent->'erased' IS DISTINCT FROM 'true'::jsonb
     OR agent->>'status' IS DISTINCT FROM 'erased'
     OR agent->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
     OR agent->>'hushhId' IS DISTINCT FROM reservation->>'hushhId'
     OR agent->>'serviceUid' IS DISTINCT FROM snapshot->'backend_metadata'->>'serviceUid'
     OR jsonb_typeof(agent->'service') IS DISTINCT FROM 'string'
     OR jsonb_typeof(agent->'revision') IS DISTINCT FROM 'string'
     OR jsonb_typeof(agent->'deleted') IS DISTINCT FROM 'number'
     OR jsonb_typeof(agent->'alreadyAbsent') IS DISTINCT FROM 'number'
     OR jsonb_typeof(agent->'records') IS DISTINCT FROM 'number'
     OR coalesce(agent->>'deleted','') !~ '^[0-9]{1,9}$'
     OR coalesce(agent->>'alreadyAbsent','') !~ '^[0-9]{1,9}$'
     OR coalesce(agent->>'records','') !~ '^[0-9]{1,9}$' THEN RETURN false; END IF;
  -- Legacy checkpoints remain readable with UNKNOWN provider outcomes.
  -- Retain every new outcome before revoking access; incomplete revocation is
  -- evidence to preserve, never proof that provider cleanup has completed.
  IF agent ? 'providerCoverage' AND agent->'providerCoverage' IS DISTINCT FROM
       '"connector_history_v1"'::jsonb THEN RETURN false; END IF;
  IF agent ?| ARRAY['providerRevoked','providerUnconfirmed','providerUnavailable','providerCoverage'] THEN
    IF NOT agent ?& ARRAY['providerRevoked','providerUnconfirmed','providerUnavailable']
       OR jsonb_typeof(agent->'providerRevoked') IS DISTINCT FROM 'number'
       OR jsonb_typeof(agent->'providerUnconfirmed') IS DISTINCT FROM 'number'
       OR jsonb_typeof(agent->'providerUnavailable') IS DISTINCT FROM 'number'
       OR coalesce(agent->>'providerRevoked','') !~ '^[0-9]{1,3}$'
       OR coalesce(agent->>'providerUnconfirmed','') !~ '^[0-9]{1,3}$'
       OR coalesce(agent->>'providerUnavailable','') !~ '^[01]$'
    THEN RETURN false; END IF;
    IF (agent->>'providerRevoked')::int + (agent->>'providerUnconfirmed')::int > 128
       OR ((agent->>'providerUnavailable')::int = 1 AND
         ((agent->>'providerRevoked')::int <> 0 OR (agent->>'providerUnconfirmed')::int <> 0))
    THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

-- Storage accepts legacy observations; destructive cleanup requires positive
-- historical coverage. Zero counters alone cannot qualify an older receipt.
CREATE OR REPLACE FUNCTION public.erasure_provider_revocation_complete(reservation jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT coalesce(public.valid_erasure_owner_access_checkpoint(
   reservation,reservation->'agentCryptoErase') IS TRUE
  AND reservation#>'{agentCryptoErase,agentErased,providerCoverage}'=
      '"connector_history_v1"'::jsonb
  AND reservation#>'{agentCryptoErase,agentErased,providerUnconfirmed}'='0'::jsonb
  AND reservation#>'{agentCryptoErase,agentErased,providerUnavailable}'='0'::jsonb,false);
$$;

COMMIT;
