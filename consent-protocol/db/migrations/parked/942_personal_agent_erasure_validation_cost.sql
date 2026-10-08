-- Dev-only receipt validation: check unchanged prerequisites once per family.
-- The current receipt passes all shape/owner/resource checks before predecessor
-- comparison. Equal non-status payload plus the exact prior status proves that
-- predecessor has the same validated shape. No caller-provided cache or bypass.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_secret_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE obs jsonb; ident jsonb; inv jsonb; admitted jsonb; project text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_kms_receipt(r,'completion',r->'kmsErasure'->'completion') IS DISTINCT FROM true THEN RETURN false; END IF;
 obs:=receipt->'resourceObservation'; ident:=obs->'identity'; inv:=r->'substrateInventory'; project:=r->'registrySnapshot'->>'user_cloud_project';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','etag','status'] <> '{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(receipt->'etag') IS DISTINCT FROM 'string' OR length(btrim(receipt->>'etag')) NOT BETWEEN 1 AND 512
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'secret' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,255}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','projectId','projectNumber','createTime'] <> '{}'::jsonb
 OR project IS NULL OR ident->>'projectId' IS DISTINCT FROM project
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF ident ? 'projectNumber' AND (jsonb_typeof(ident->'projectNumber') IS DISTINCT FROM 'string' OR ident->>'projectNumber' !~ '^[1-9][0-9]{0,19}$') THEN RETURN false; END IF;
 IF ident->>'name' IS DISTINCT FROM 'projects/' || project || '/secrets/' || (obs->>'id')
 AND (NOT (ident ? 'projectNumber') OR ident->>'name' IS DISTINCT FROM 'projects/' || (ident->>'projectNumber') || '/secrets/' || (obs->>'id')) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'secretErasure'->'admission';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF admitted->>'status' IS DISTINCT FROM 'admitted' OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 admitted:=r->'secretErasure'->'acknowledgement';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN receipt->>'status'='absent' AND admitted->>'status' IS NOT DISTINCT FROM 'acknowledged'
   AND receipt - 'status' IS NOT DISTINCT FROM admitted - 'status';
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_account_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE obs jsonb; inv jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_secret_receipt(r,'deletion',r->'secretErasure'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 obs:=receipt->'resourceObservation'; inv:=r->'substrateInventory';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'service_account' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS DISTINCT FROM r->'writerDisabled'->'runtimeIdentity'->>'email'
 OR obs->'identity' IS DISTINCT FROM r->'writerDisabled'->'runtimeIdentity'
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='service_account' AND x->>'id'<>obs->>'id'
   AND (x->>'id' IS DISTINCT FROM r->'filesErasure'->'worker'->'deletion'->'resourceObservation'->>'id'
     OR public.valid_erasure_files_receipt(r,'worker','deletion',r->'filesErasure'->'worker'->'deletion') IS DISTINCT FROM true))
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='service_account' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'accountErasure'->'admission';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF admitted->>'status' IS DISTINCT FROM 'admitted' OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 admitted:=r->'accountErasure'->'acknowledgement';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN receipt->>'status'='absent' AND admitted->>'status' IS NOT DISTINCT FROM 'acknowledged'
   AND receipt - 'status' IS NOT DISTINCT FROM admitted - 'status';
END;
$$;
COMMIT;
