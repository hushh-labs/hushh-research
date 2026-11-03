"""Canonical hosted custody family SQL template."""

from __future__ import annotations

_FAMILY_SQL = r"""DO $hosted_custody_full_family$
DECLARE family jsonb := convert_from(decode('@FAMILY_JSON_HEX@','hex'),'UTF8')::jsonb;
 preimages jsonb := convert_from(decode('@PREIMAGES_JSON_HEX@','hex'),'UTF8')::jsonb;
 alternate_hashes jsonb := convert_from(decode('@ALTERNATE_HASHES_JSON_HEX@','hex'),'UTF8')::jsonb;
 family_names text[]; family_footprint boolean; marker_oid oid; registry_owner oid;
 service_role_oid oid; marker record; marker_signature_attnum smallint; function_failure text;
 canonical_acl_profile boolean; native_acl_profile boolean;
 owner_canonical_acl_profile boolean; owner_native_acl_profile boolean;
 expected_count integer := @FAMILY_COUNT@; actual_count integer;
BEGIN
 PERFORM set_config('@SETTING@','false',true);
 PERFORM set_config('@NATIVE_SETTING@','',true);
 @PROFILE_IDENTITY_SQL@
 SELECT array_agg(DISTINCT f.proname ORDER BY f.proname)
  INTO family_names FROM jsonb_to_recordset(family) AS f(
   signature text,proname text,expected_hash text,base_hash text,files_hash text,
   upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
   public_required boolean,introduced boolean,function_path text);
 marker_oid:=to_regclass('public.@MARKER@')::oid;
 SELECT marker_oid IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=ANY(ARRAY(
    SELECT f.proname FROM jsonb_to_recordset(family) AS f(
     signature text,proname text,expected_hash text,base_hash text,files_hash text,
     upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
     public_required boolean,introduced boolean,function_path text) WHERE f.introduced)))
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND t.tgname='@TRIGGER@')
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(family) AS f(
   signature text,proname text,expected_hash text,base_hash text,files_hash text,
   upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
   public_required boolean,introduced boolean,function_path text)
   JOIN pg_proc p ON p.oid=to_regprocedure('public.'||f.signature)
   WHERE (f.files_hash<>'' AND f.files_hash<>f.base_hash
      AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.files_hash)
    OR (f.upgrade_hash<>'' AND f.upgrade_hash<>f.base_hash
      AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.upgrade_hash)
    OR (f.native_contract_hash<>'' AND f.native_contract_hash<>f.base_hash
      AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=f.native_contract_hash))
 INTO family_footprint;
 IF family_footprint IS NOT TRUE THEN
  IF @REQUIRE_FAMILY@ THEN
   RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: required family absent';
  END IF;
  RETURN;
 END IF;
 IF marker_oid IS NULL THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: missing rollback marker';
 END IF;

 SELECT c.* INTO marker FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.oid=marker_oid;
 IF NOT FOUND OR marker.relkind<>'r' OR marker.relpersistence<>'p' THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback marker relation';
 END IF;
 SELECT c.relowner INTO registry_owner FROM pg_class c
  WHERE c.oid=to_regclass('public.personal_agent_registry') AND c.relkind='r';
 SELECT r.oid INTO service_role_oid FROM pg_roles r WHERE r.rolname='service_role';
 IF registry_owner IS NULL THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: owner roles';
 END IF;
 IF '@PROFILE@'='dev_control_plane_owner' THEN
  IF service_role_oid IS NOT NULL THEN
   RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: Dev service role';
  END IF;
 ELSIF service_role_oid IS NULL OR service_role_oid=registry_owner THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: owner roles';
 END IF;
 IF marker.relowner<>registry_owner THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback marker owner';
 END IF;

 SELECT a.attnum INTO marker_signature_attnum FROM pg_attribute a
  WHERE a.attrelid=marker_oid AND a.attname='signature' AND a.attnum>0 AND NOT a.attisdropped;
 IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=marker_oid
     AND a.attnum>0 AND NOT a.attisdropped)<>2
  OR marker_signature_attnum IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=marker_oid AND a.attname='signature' AND a.attnum>0
     AND NOT a.attisdropped AND a.atttypid='pg_catalog.text'::regtype
     AND a.atttypmod=-1 AND a.attndims=0 AND a.attnotnull AND a.attidentity=''
     AND a.attgenerated='' AND d.oid IS NULL)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=marker_oid AND a.attname='definition' AND a.attnum>0
     AND NOT a.attisdropped AND a.atttypid='pg_catalog.text'::regtype
     AND a.atttypmod=-1 AND a.attndims=0 AND a.attnotnull AND a.attidentity=''
     AND a.attgenerated='' AND d.oid IS NULL)
  OR (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=marker_oid)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=marker_oid
    AND k.contype='p' AND k.conkey=ARRAY[marker_signature_attnum]::smallint[]
    AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
    AND k.connoinherit AND k.conislocal AND k.coninhcount=0 AND k.conparentid=0)
  OR (SELECT count(*) FROM pg_index i WHERE i.indrelid=marker_oid)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_constraint k ON k.conindid=i.indexrelid
    WHERE i.indrelid=marker_oid AND k.conrelid=marker_oid AND k.contype='p'
     AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indisprimary
     AND NOT i.indisexclusion AND i.indnatts=1 AND i.indnkeyatts=1
     AND i.indexprs IS NULL AND i.indpred IS NULL
     AND i.indkey::text=marker_signature_attnum::text)
  OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=marker_oid AND NOT t.tgisinternal)
  OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(marker.relacl,
      acldefault('r',marker.relowner))) a
    WHERE a.grantee<>marker.relowner OR a.grantor<>marker.relowner OR a.is_grantable)
  OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(marker.relacl,
      acldefault('r',marker.relowner))) a WHERE NOT EXISTS(
    SELECT 1 FROM aclexplode(acldefault('r',marker.relowner)) d
    WHERE (d.grantee,d.grantor,d.privilege_type,d.is_grantable)=
      (a.grantee,a.grantor,a.privilege_type,a.is_grantable)))
  OR EXISTS(SELECT 1 FROM aclexplode(acldefault('r',marker.relowner)) d
    WHERE NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(marker.relacl,
      acldefault('r',marker.relowner))) a
      WHERE (a.grantee,a.grantor,a.privilege_type,a.is_grantable)=
       (d.grantee,d.grantor,d.privilege_type,d.is_grantable))) THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback marker shape or ACL';
 END IF;
 IF (SELECT count(*) FROM public.@MARKER@)<>5
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(preimages) AS e(
   signature text,definition_hash text)
   LEFT JOIN public.@MARKER@ s ON s.signature=e.signature
   WHERE s.signature IS NULL OR encode(sha256(convert_to(s.definition,'UTF8')),'hex')
      IS DISTINCT FROM e.definition_hash)
  OR EXISTS(SELECT 1 FROM public.@MARKER@ s WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_to_recordset(preimages) AS e(signature text,definition_hash text)
   WHERE e.signature=s.signature)) THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: rollback preimages';
 END IF;

 SELECT count(*) INTO actual_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname=ANY(family_names);
 IF actual_count<>expected_count OR EXISTS(SELECT 1 FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=ANY(family_names)
    AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(family) AS f(
     signature text,proname text,expected_hash text,base_hash text,files_hash text,
     upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
     public_required boolean,introduced boolean,function_path text)
     WHERE to_regprocedure('public.'||f.signature)=p.oid)) THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: overload or missing function';
 END IF;
 SELECT f.signature INTO function_failure
  FROM jsonb_to_recordset(family) AS f(
   signature text,proname text,expected_hash text,base_hash text,files_hash text,
   upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
   public_required boolean,introduced boolean,function_path text)
   LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||f.signature)
   WHERE p.oid IS NULL
    OR (
      encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')<>f.expected_hash
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(
       COALESCE(alternate_hashes->f.signature,'[]'::jsonb)) allowed(hash)
       WHERE allowed.hash=encode(
        sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'))
    )
    OR p.proowner<>registry_owner OR p.prosecdef IS TRUE OR p.proparallel<>'u'
    OR p.proleakproof IS TRUE OR p.proisstrict IS TRUE OR p.proretset IS TRUE
    OR p.prokind<>'f' OR p.proargmodes IS NOT NULL OR p.provariadic<>0
    OR p.procost<>100 OR p.prorows<>0
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path='||f.function_path]::text[]
  LIMIT 1;
 IF function_failure IS NOT NULL THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: function vector or metadata (%)',
   function_failure;
 END IF;

 @ACL_PROFILE_SQL@
 IF '@PROFILE@'='dev_control_plane_owner' THEN
  IF owner_canonical_acl_profile IS NOT TRUE AND owner_native_acl_profile IS NOT TRUE THEN
   RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: owner-only function ACL';
  END IF;
 ELSIF canonical_acl_profile IS NOT TRUE AND native_acl_profile IS NOT TRUE THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: function ACL';
 END IF;

 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND t.tgname='@TRIGGER@')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.oid=to_regclass('public.personal_agent_registry')
    AND t.tgname='@TRIGGER@' AND t.tgenabled IN ('O','A') AND t.tgtype=23
    AND t.tgfoid=to_regprocedure('public.guard_personal_agent_upgrade_lease_host_binding()')
    AND NOT t.tgisinternal AND t.tgnargs=0 AND encode(t.tgargs,'hex')=''
    AND t.tgattr::text='' AND t.tgconstraint=0 AND NOT t.tgdeferrable
    AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgoldtable IS NULL
    AND t.tgnewtable IS NULL AND t.tgparentid=0
    AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
      ='@TRIGGER_SHA@') THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: upgrade host trigger';
 END IF;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND t.tgname='@PROJECT_GRANT_TRIGGER@')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.oid=to_regclass('public.personal_agent_registry')
      AND t.tgname='@PROJECT_GRANT_TRIGGER@' AND t.tgenabled IN ('O','A') AND t.tgtype=23
      AND t.tgfoid=to_regprocedure('public.guard_project_grant_registry_admission()')
      AND NOT t.tgisinternal AND t.tgnargs=0 AND encode(t.tgargs,'hex')=''
      AND t.tgattr::text='' AND t.tgconstraint=0 AND NOT t.tgdeferrable
      AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgoldtable IS NULL
      AND t.tgnewtable IS NULL AND t.tgparentid=0
      AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
       ='@PROJECT_GRANT_TRIGGER_SHA@') THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: project grant trigger';
 END IF;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND t.tgname='@ERASURE_REGISTRY_TRIGGER@')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.oid=to_regclass('public.personal_agent_registry')
      AND t.tgname='@ERASURE_REGISTRY_TRIGGER@' AND t.tgenabled IN ('O','A') AND t.tgtype=27
      AND t.tgfoid=to_regprocedure('public.guard_personal_agent_erasure_registry()')
      AND NOT t.tgisinternal AND t.tgnargs=0 AND encode(t.tgargs,'hex')=''
      AND t.tgattr::text='' AND t.tgconstraint=0 AND NOT t.tgdeferrable
      AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgoldtable IS NULL
      AND t.tgnewtable IS NULL AND t.tgparentid=0
      AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
       ='@ERASURE_REGISTRY_TRIGGER_SHA@') THEN
  RAISE EXCEPTION 'Unqualified managed 979/980/981 custody family: erasure registry trigger';
 END IF;
 IF native_acl_profile IS TRUE
  OR ('@PROFILE@'='dev_control_plane_owner'
      AND (owner_canonical_acl_profile IS TRUE OR owner_native_acl_profile IS TRUE)) THEN
  PERFORM set_config('@NATIVE_SETTING@','true',true);
 END IF;
 PERFORM set_config('@SETTING@','true',true);
END
$hosted_custody_full_family$;
"""
