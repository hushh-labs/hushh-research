"""Closed qualification for the Dev provider-account function families."""

from __future__ import annotations

from collections.abc import Mapping, Set

_TRANSITION_FAMILY_SQL = """
DO $hosted_provider_account_transition_family$
DECLARE spec record; actual_count integer; registry_owner oid; service_role_oid oid;
        transition_footprint boolean := false;
BEGIN
 SELECT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proname=ANY(ARRAY[@NAMES_SQL@]::text[]))
  OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgname='@TRIGGER_NAME@')
  OR (to_regprocedure('public.personal_agent_erasure_archive(jsonb,jsonb)') IS NOT NULL
      AND encode(sha256(convert_to(pg_get_functiondef(
        to_regprocedure('public.personal_agent_erasure_archive(jsonb,jsonb)')),'UTF8')),'hex')
        ='@ARCHIVE_SHA256@')
  INTO transition_footprint;
 IF transition_footprint IS NOT TRUE THEN RETURN; END IF;
 IF @ALLOWED_ROLE@ IS NOT TRUE THEN
  RAISE EXCEPTION 'Unqualified provider account transition family: explicit Dev profile required';
 END IF;
 SELECT c.relowner INTO registry_owner FROM pg_class c
  WHERE c.oid=to_regclass('public.personal_agent_registry') AND c.relkind='r';
 SELECT oid INTO service_role_oid FROM pg_roles WHERE rolname='service_role';
 SELECT count(*) INTO actual_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname=ANY(ARRAY[@NAMES_SQL@]::text[]);
 IF actual_count<>@FAMILY_COUNT@
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proname=ANY(ARRAY[@NAMES_SQL@]::text[])
      AND (n.nspname<>'public' OR NOT EXISTS(SELECT 1 FROM (VALUES @VALUES@) e(signature,digest)
       WHERE to_regprocedure('public.'||e.signature)=p.oid))) THEN
  RAISE EXCEPTION 'Unqualified provider account transition family: overload or missing function';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES @VALUES@) e(signature,digest)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||e.signature)
    WHERE p.oid IS NULL
      OR (encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')<>e.digest
          AND NOT (e.signature='valid_hosted_provider_account_transition_intent(jsonb,jsonb)'
              AND @ALLOWED_ROLE@ IS TRUE
              AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
                   IN ('@INTENT_SUCCESSOR_SHA256@','@INTENT_ADDITIONAL_SUCCESSOR_SHA256@')))
      OR p.proowner<>registry_owner OR p.prosecdef IS TRUE OR p.proleakproof IS TRUE
      OR p.proisstrict IS TRUE OR p.proretset IS TRUE OR p.prokind<>'f'
      OR p.proargmodes IS NOT NULL OR p.provariadic<>0
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,
         acldefault('f',p.proowner))) a
        WHERE (a.grantee<>p.proowner AND (service_role_oid IS NULL
                OR a.grantee<>service_role_oid)) OR a.is_grantable)
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,
         acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')
          AND has_function_privilege('anon',p.oid,'EXECUTE'))
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
          AND has_function_privilege('authenticated',p.oid,'EXECUTE'))
      OR (service_role_oid IS NOT NULL
          AND NOT has_function_privilege(service_role_oid,p.oid,'EXECUTE'))) THEN
  RAISE EXCEPTION 'Unqualified provider account transition family: function definition or ACL';
 END IF;
 IF (SELECT count(*) FROM pg_trigger t WHERE t.tgname='@TRIGGER_NAME@')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid=to_regclass('public.personal_agent_registry')
      AND t.tgname='@TRIGGER_NAME@' AND t.tgenabled IN ('O','A') AND t.tgtype=31
      AND t.tgfoid=to_regprocedure('public.guard_hosted_provider_account_transition_registry()')
      AND NOT t.tgisinternal AND t.tgnargs=0 AND encode(t.tgargs,'hex')=''
      AND t.tgattr::text='' AND t.tgconstraint=0 AND NOT t.tgdeferrable
      AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgoldtable IS NULL
      AND t.tgnewtable IS NULL AND t.tgparentid=0
      AND encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
        ='@TRIGGER_SHA256@') THEN
  RAISE EXCEPTION 'Unqualified provider account transition family: trigger definition';
 END IF;
END;
$hosted_provider_account_transition_family$;
"""

_RESOLUTION_FAMILY_SQL = """
DO $hosted_provider_account_resolution_family$
DECLARE spec record; actual_count integer; registry_owner oid; service_role_oid oid;
        resolution_footprint boolean := false;
BEGIN
 SELECT to_regprocedure('public.@RESOLVER_SIGNATURE@') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proname='hosted_provider_effective_billing_account')
  OR EXISTS(SELECT 1 FROM (VALUES @VALUES@) e(signature,digest,direct_service)
   WHERE to_regprocedure('public.'||e.signature) IS NOT NULL
    AND encode(sha256(convert_to(pg_get_functiondef(
      to_regprocedure('public.'||e.signature)),'UTF8')),'hex')=e.digest)
  INTO resolution_footprint;
 IF resolution_footprint IS NOT TRUE THEN RETURN; END IF;
 IF @ALLOWED_ROLE@ IS NOT TRUE THEN
  RAISE EXCEPTION 'Unqualified provider account resolution family: explicit Dev profile required';
 END IF;
 SELECT c.relowner INTO registry_owner FROM pg_class c
  WHERE c.oid=to_regclass('public.personal_agent_registry') AND c.relkind='r';
 SELECT oid INTO service_role_oid FROM pg_roles WHERE rolname='service_role';
 SELECT count(*) INTO actual_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname=ANY(ARRAY[@NAMES_SQL@]::text[]);
 IF actual_count<>@FAMILY_COUNT@
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proname=ANY(ARRAY[@NAMES_SQL@]::text[])
      AND (n.nspname<>'public' OR NOT EXISTS(SELECT 1 FROM (VALUES @VALUES@) e(signature,digest,direct_service)
       WHERE to_regprocedure('public.'||e.signature)=p.oid))) THEN
  RAISE EXCEPTION 'Unqualified provider account resolution family: overload or missing function';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES @VALUES@) e(signature,digest,direct_service)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||e.signature)
    WHERE p.oid IS NULL
      OR (encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')<>e.digest
          AND NOT (e.signature='valid_hosted_provider_account_transition_intent(jsonb,jsonb)'
              AND @ALLOWED_ROLE@ IS TRUE
              AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
                  ='@INTENT_SUCCESSOR_SHA256@'))
      OR p.proowner<>registry_owner OR p.prosecdef IS TRUE OR p.proleakproof IS TRUE
      OR p.proisstrict IS TRUE OR p.proretset IS TRUE OR p.prokind<>'f'
      OR p.proargmodes IS NOT NULL OR p.provariadic<>0
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
         WHERE a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
          OR (a.grantee<>p.proowner AND (service_role_oid IS NULL
              OR a.grantee<>service_role_oid OR e.direct_service IS NOT TRUE))
          OR (a.grantee=p.proowner AND a.grantee=0))
      OR (SELECT count(*) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)
         <>1+CASE WHEN e.direct_service AND service_role_oid IS NOT NULL THEN 1 ELSE 0 END
      OR NOT has_function_privilege(p.proowner,p.oid,'EXECUTE')
      OR (e.direct_service AND service_role_oid IS NOT NULL
          AND NOT has_function_privilege(service_role_oid,p.oid,'EXECUTE'))
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')
          AND has_function_privilege('anon',p.oid,'EXECUTE'))
      OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
          AND has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN
  RAISE EXCEPTION 'Unqualified provider account resolution family: function definition or ACL';
 END IF;
END;
$hosted_provider_account_resolution_family$;
"""


def _render(template: str, replacements: Mapping[str, str]) -> str:
    for token, value in replacements.items():
        template = template.replace("@" + token + "@", value)
    return template


def _provider_transition_family_qualification_sql(
    *,
    family: Mapping[str, str],
    trigger: tuple[str, str],
    archive_sha256: str,
    dev_profile: bool,
    intent_successor_sha256: str = "",
    intent_additional_successor_sha256: str = "",
) -> str:
    values = ",".join(f"('{signature}','{digest}')" for signature, digest in sorted(family.items()))
    names = sorted({signature.partition("(")[0] for signature in family})
    trigger_name, trigger_sha256 = trigger
    return _render(
        _TRANSITION_FAMILY_SQL,
        {
            "NAMES_SQL": ",".join(f"'{name}'" for name in names),
            "TRIGGER_NAME": trigger_name,
            "ARCHIVE_SHA256": archive_sha256,
            "ALLOWED_ROLE": "TRUE" if dev_profile else "FALSE",
            "FAMILY_COUNT": str(len(family)),
            "VALUES": values,
            "INTENT_SUCCESSOR_SHA256": intent_successor_sha256,
            "INTENT_ADDITIONAL_SUCCESSOR_SHA256": intent_additional_successor_sha256,
            "TRIGGER_SHA256": trigger_sha256,
        },
    )


def _provider_account_resolution_family_qualification_sql(
    *,
    family: Mapping[str, str],
    service_role_signatures: Set[str],
    dev_profile: bool,
    intent_successor_sha256: str = "",
) -> str:
    values = ",".join(
        f"('{signature}','{digest}',{'true' if signature in service_role_signatures else 'false'})"
        for signature, digest in sorted(family.items())
    )
    names = sorted({signature.partition("(")[0] for signature in family})
    return _render(
        _RESOLUTION_FAMILY_SQL,
        {
            "RESOLVER_SIGNATURE": "hosted_provider_effective_billing_account(jsonb)",
            "VALUES": values,
            "ALLOWED_ROLE": "TRUE" if dev_profile else "FALSE",
            "NAMES_SQL": ",".join(f"'{name}'" for name in names),
            "FAMILY_COUNT": str(len(family)),
            "INTENT_SUCCESSOR_SHA256": intent_successor_sha256,
        },
    )


def append_provider_account_qualification_sql(
    sql: str,
    *,
    profile,
    provider_transition_family,
    provider_transition_trigger,
    provider_transition_archive_sha256,
    provider_transition_intent_successor_sha256,
    provider_transition_intent_additional_successor_sha256,
    provider_account_resolution_family,
    provider_account_resolution_service_role_signatures,
    provider_account_resolution_intent_successor_sha256,
) -> str:
    if provider_transition_family is not None or provider_transition_trigger is not None:
        required = (
            provider_transition_family,
            provider_transition_trigger,
            provider_transition_archive_sha256,
            provider_transition_intent_successor_sha256,
        )
        if any(value is None for value in required):
            raise ValueError(
                "provider transition qualification requires the complete closed family"
            )
        transition_sql = _provider_transition_family_qualification_sql(
            family=provider_transition_family,
            trigger=provider_transition_trigger,
            archive_sha256=provider_transition_archive_sha256,
            dev_profile=profile.is_dev_control_plane_owner,
            intent_successor_sha256=provider_transition_intent_successor_sha256,
            intent_additional_successor_sha256=(
                provider_transition_intent_additional_successor_sha256
            ),
        )
        sql = sql + transition_sql if profile.is_dev_control_plane_owner else transition_sql + sql
    if provider_account_resolution_family is not None:
        sql += _provider_account_resolution_family_qualification_sql(
            family=provider_account_resolution_family,
            service_role_signatures=provider_account_resolution_service_role_signatures,
            dev_profile=profile.is_dev_control_plane_owner,
            intent_successor_sha256=provider_account_resolution_intent_successor_sha256,
        )
    return sql
