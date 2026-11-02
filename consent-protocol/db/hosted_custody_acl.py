"""Exact ACL profiles and source-pinned replay preservation for custody SQL."""

from __future__ import annotations

QUALIFIED_FAMILY_SETTING = "hushh.custody_full_979_980_981_qualified"
NATIVE_ACL_PROFILE_SETTING = "hushh.custody_native_89_acl_profile"

NATIVE_PUBLIC_SIGNATURES = frozenset(
    {
        "azure_vm_image_publication_proven(personal_agent_registry,personal_agent_registry)",
        "guard_personal_agent_upgrade_lease_host_binding()",
        "personal_agent_upgrade_lease_host_binding(jsonb)",
        "valid_byoc_azure_worker_event(text,text,jsonb,jsonb,text,text)",
        "valid_erasure_memory_binding(jsonb,jsonb)",
        "valid_erasure_substrate_inventory(jsonb,jsonb)",
    }
)

_NATIVE_ACL_VALIDATORS = (
    (
        "azure_vm_image_publication_proven",
        "personal_agent_registry, personal_agent_registry",
    ),
    (
        "valid_byoc_azure_worker_event",
        "text, text, jsonb, jsonb, text, text",
    ),
    ("valid_erasure_memory_binding", "jsonb, jsonb"),
    ("valid_erasure_substrate_inventory", "jsonb, jsonb"),
)


def family_acl_profile_sql() -> str:
    """Return the exact whole-vector canonical/native ACL profile query."""
    return r"""
 SELECT
  bool_and(acl_valid) FILTER (WHERE profile_name='canonical'),
  bool_and(acl_valid) FILTER (WHERE profile_name='native')
 INTO canonical_acl_profile,native_acl_profile
 FROM (
  SELECT expected.profile_name,
   EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,
       acldefault('f',p.proowner))) a WHERE a.grantee=p.proowner
       AND a.grantor=p.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
    AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,
       acldefault('f',p.proowner))) a WHERE a.grantee NOT IN
        (p.proowner,service_role_oid,0)
       OR a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
       OR (a.grantee=service_role_oid AND expected.direct_service IS NOT TRUE)
       OR (a.grantee=0 AND expected.public_required IS NOT TRUE))
    AND COALESCE((SELECT bool_or(a.grantee=service_role_oid
       AND a.privilege_type='EXECUTE')
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a),false)
       IS NOT DISTINCT FROM expected.direct_service
    AND COALESCE((SELECT bool_or(a.grantee=0 AND a.privilege_type='EXECUTE')
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a),false)
       IS NOT DISTINCT FROM expected.public_required
    AND (f.service_required IS NOT TRUE
       OR has_function_privilege(service_role_oid,p.oid,'EXECUTE')) AS acl_valid
  FROM jsonb_to_recordset(family) AS f(
   signature text,proname text,expected_hash text,base_hash text,files_hash text,
   upgrade_hash text,native_contract_hash text,direct_service boolean,service_required boolean,
   public_required boolean,introduced boolean,function_path text,
   native_direct_service boolean,native_public_required boolean)
  JOIN pg_proc p ON p.oid=to_regprocedure('public.'||f.signature)
  CROSS JOIN LATERAL (VALUES
   ('canonical',f.direct_service,f.public_required),
   ('native',f.native_direct_service,f.native_public_required)
  ) AS expected(profile_name,direct_service,public_required)
 ) profiles;
"""


def preserve_native_family_acl(sql: str) -> str:
    """Wrap only the twelve ACL statements pinned in immutable migration 420."""
    native_gate = (
        f"(current_setting('{QUALIFIED_FAMILY_SETTING}',true)='true') IS TRUE "
        f"AND (current_setting('{NATIVE_ACL_PROFILE_SETTING}',true)='true') IS TRUE"
    )
    for index, (name, arguments) in enumerate(_NATIVE_ACL_VALIDATORS, start=1):
        function = f'public."{name}"({arguments})'
        revoke_public = f"REVOKE ALL ON FUNCTION {function} FROM PUBLIC;"
        grant_service = f"GRANT EXECUTE ON FUNCTION {function} TO service_role;"
        revoke_clients = f"EXECUTE format('REVOKE ALL ON FUNCTION {function} FROM %I',client_role);"
        anchors = (
            (
                revoke_public,
                f"DO $native_acl_preserve_{index}$\nBEGIN\n"
                f" IF NOT ({native_gate}) THEN\n"
                f"  EXECUTE '{revoke_public[:-1]}';\n"
                " END IF;\nEND\n"
                f"$native_acl_preserve_{index}$;",
            ),
            (
                grant_service,
                f"IF NOT ({native_gate}) THEN {grant_service} END IF;",
            ),
            (
                revoke_clients,
                f"IF NOT ({native_gate}) THEN {revoke_clients} END IF;",
            ),
        )
        for anchor, replacement in anchors:
            if sql.count(anchor) != 1:
                raise ValueError(f"immutable 420 ACL anchor changed: {name}")
            sql = sql.replace(anchor, replacement, 1)
    return sql
