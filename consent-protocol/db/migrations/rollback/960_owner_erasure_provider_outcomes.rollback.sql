-- Refuse rollback after new outcomes are retained; dropping them is not recovery.
BEGIN;
-- Serialize the admission scan with reserve_erasure's row updates. Otherwise a
-- reservation could start after the scan but before the old validator commits.
LOCK TABLE public.personal_agent_registry IN SHARE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.personal_agent_registry WHERE
    (backend_metadata#>>'{erasure,registrySnapshot,deployment_target}' = 'user_azure'
      AND backend_metadata#>>'{erasure,phase}' = 'reserved')
    OR (backend_metadata#>'{erasure,agentCryptoErase,agentErased}') ?|
      ARRAY['providerRevoked','providerUnconfirmed','providerUnavailable']
    OR (backend_metadata#>'{erasure,ownerAccessErasure,agentErased}') ?|
      ARRAY['providerRevoked','providerUnconfirmed','providerUnavailable'])
  THEN RAISE EXCEPTION 'Active erasure or retained provider outcomes require forward recovery'; END IF;
END $$;

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
       'deleted','alreadyAbsent','records'] <> '{}'::jsonb
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
  RETURN true;
END;
$$;

DROP FUNCTION public.erasure_provider_revocation_complete(jsonb);

COMMIT;
