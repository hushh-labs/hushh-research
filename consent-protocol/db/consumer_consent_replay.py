"""Qualify retained consumer consent guards without importing their feature.

The two guards were installed by peer migrations 938/939 on dev. Replay keeps
their authority and all records. The migration advisory lock serializes governed
DDL; privileged out-of-band DDL must take that same lock.
"""

from __future__ import annotations

import hashlib

SOURCE_KEY = ("420", "420_private_agent_lifecycle_foundation.sql")
SOURCE_SHA = "78981e14e2dc4ef0d40a6275f785a5015367ea08d00ab7b4ef352538cb612f2d"

# pg_get_functiondef fingerprints verified against live dev and the authored
# peer sources: 253e89abe8/938 and ac86743508/939. No function is replaced here.
_FUNCTIONS = (
    (
        "guard_consumer_memory_consent",
        "2ccca2cea80161124e4394a01ae7b250f23b1ee2d25a23f8658cb23a6047fb03",
    ),
    (
        "preserve_consumer_memory_consent",
        "1b09276b80d8f10582587ea4d12512b14f05055c6ef77612e37b000a1646668b",
    ),
)
_TRIGGERS = (
    ("zz_consumer_memory_consent", "guard_consumer_memory_consent", 7),
    ("zz_preserve_consumer_memory_consent", "preserve_consumer_memory_consent", 27),
)
_INVENTORY_END = (
    ") expected(t,name) WHERE expected.t=actual.t AND expected.name=actual.name)) "
    "THEN RAISE EXCEPTION 'Unqualified private-agent triggers';"
)
_PREFIX = "SET LOCAL check_function_bodies=off;\n"


def _qualification() -> str:
    functions = ",".join(f"('{name}','{digest}')" for name, digest in _FUNCTIONS)
    triggers = ",".join(f"('{name}','{function}',{kind})" for name, function, kind in _TRIGGERS)
    return f"""
DO $qualified_consumer_consent$
BEGIN
 IF to_regclass('public.consumer_mcp_connections') IS NULL
    AND to_regprocedure('public.guard_consumer_memory_consent()') IS NULL
    AND to_regprocedure('public.preserve_consumer_memory_consent()') IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
        AND tgname IN ('zz_consumer_memory_consent','zz_preserve_consumer_memory_consent'))
 THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.consumer_mcp_connections')
                  AND relkind='r' AND relpersistence='p')
    OR (SELECT count(*) FROM (VALUES {functions}) expected(name,digest)
      JOIN pg_proc p ON p.oid=to_regprocedure('public.' || expected.name || '()')
      JOIN pg_language l ON l.oid=p.prolang
      JOIN pg_class c ON c.oid='public.consent_audit'::regclass
      WHERE p.proowner=c.relowner AND p.prokind='f' AND p.pronargs=0
        AND p.prorettype='pg_catalog.trigger'::regtype AND NOT p.proretset
        AND l.lanname='plpgsql' AND NOT p.prosecdef AND NOT p.proleakproof
        AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=expected.digest) <> 2
    OR (SELECT count(*) FROM (VALUES {triggers}) expected(name,function_name,kind)
      JOIN pg_trigger t ON t.tgrelid='public.consent_audit'::regclass AND t.tgname=expected.name
      WHERE t.tgfoid=to_regprocedure('public.' || expected.function_name || '()')
        AND t.tgtype=expected.kind AND t.tgenabled='O' AND NOT t.tgisinternal
        AND t.tgnargs=0 AND t.tgattr=''::int2vector AND t.tgqual IS NULL
        AND t.tgconstraint=0 AND t.tgconstrrelid=0
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL) <> 2
 THEN RAISE EXCEPTION 'Consumer consent predecessor changed; refusing lifecycle replay'; END IF;
END
$qualified_consumer_consent$;
"""


def qualified_consumer_guard_replay(sql: str) -> str:
    """Admit only the verified pair; preserve every other foundation refusal."""
    if hashlib.sha256(sql.encode()).hexdigest() != SOURCE_SHA:
        raise ValueError("Consumer consent replay source checksum changed")
    if (
        sql.count(_PREFIX) != 1
        or sql.count(_INVENTORY_END) != 1
        or not sql.rstrip().endswith("COMMIT;")
    ):
        raise ValueError("Consumer consent replay source shape changed")
    qualified = _qualification()
    extra = "," + ",".join(f"('consent_audit','{name}')" for name, _, _ in _TRIGGERS)
    replay = sql.replace(_INVENTORY_END, extra + _INVENTORY_END, 1)
    replay = replay.replace(_PREFIX, _PREFIX + qualified, 1)
    before_commit, commit = replay.rsplit("COMMIT;", 1)
    return before_commit + qualified + "COMMIT;" + commit
