"""Exact schema successor for human-approved Browser credential entry."""

from __future__ import annotations

import re

MARKER = "browser-credential-fill.v1/467"
IDENTITY = "pod_chat_action_identity"


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def definitions(*, successor: bool) -> dict[str, str]:
    # Preserve the existing private-action owner's predecessor definitions.
    from db.private_action_replay import _EXPECTED

    result = dict(_EXPECTED)
    if successor:
        before = "'browser.provider_safety'::text"
        if result[IDENTITY].count(before) != 1:
            raise ValueError("Private Browser action predecessor changed")
        result[IDENTITY] = result[IDENTITY].replace(
            before, before + ",'browser.credential_fill'::text"
        )
    return result


def definition_match_sql(*, successor: bool, markers: bool = True) -> str:
    rows = ",".join(
        f"({literal(name)},{literal(rule)})"
        for name, rule in definitions(successor=successor).items()
    )
    marker = (
        f"obj_description(c.oid,'pg_constraint')={literal(MARKER)}"
        if successor
        else f"CASE WHEN c.conname={literal(IDENTITY)} THEN "
        "obj_description(c.oid,'pg_constraint') IS NULL"
        " ELSE obj_description(c.oid,'pg_constraint') IN "
        "('private-action-channel.v1/971','private-action-channel.v1/420') END"
    )
    return f"""(SELECT count(*)=3 FROM pg_constraint c
 JOIN (VALUES {rows}) AS expected(name,definition) ON c.conname=expected.name
 WHERE c.conrelid=to_regclass('public.one_action_directive_ledger')
 AND c.contype='c' AND c.convalidated
 AND regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=expected.definition
 {("AND (" + marker + ")") if markers else ""})"""


def footprint_sql() -> str:
    return f"""EXISTS(SELECT 1 FROM pg_constraint WHERE
 conrelid=to_regclass('public.one_action_directive_ledger')
 AND (obj_description(oid,'pg_constraint')={literal(MARKER)} OR
 (conname={literal(IDENTITY)} AND
 regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')=
 {literal(definitions(successor=True)[IDENTITY])})))"""


def require_successor_sql() -> str:
    return f"""IF NOT {definition_match_sql(successor=True)} THEN
 RAISE EXCEPTION 'Unqualified Browser credential authority successor';
 END IF;"""


def preserve_parked_successor_sql(source: str) -> str:
    """Keep a qualified467 guard across pending, immutable945/966/971 startup."""
    body, begin = re.subn(r"^BEGIN;[ \t]*$", "", source, flags=re.M)
    body, commit = re.subn(r"^COMMIT;[ \t]*$", "", body, flags=re.M)
    if (begin, commit) != (1, 1) or "$legacy_private_action$" in body:
        raise ValueError("Private Browser predecessor transaction shape changed")
    return f"""DO $preserve_browser_credential$
BEGIN
 LOCK TABLE public.one_action_directive_ledger IN ACCESS EXCLUSIVE MODE;
 IF {footprint_sql()} THEN
  {require_successor_sql()}
 ELSE
  EXECUTE $legacy_private_action${body}$legacy_private_action$;
 END IF;
END $preserve_browser_credential$;
"""


def qualify_foundation_sql(sql: str) -> str:
    """Admit only the measured467 constraint while replaying immutable420."""
    pattern = r"\('one_action_directive_ledger','pod_chat_action_identity','((?:''|[^'])*)',true\)"
    matches = list(re.finditer(pattern, sql))
    if len(matches) != 1:
        raise ValueError("Private-agent Browser authority inventory changed")
    match = matches[0]
    before = "''browser.provider_safety''::text"
    if match[1].count(before) != 1:
        raise ValueError("Private-agent Browser action predecessor changed")
    successor = match[0].replace(before, before + ", ''browser.credential_fill''::text")
    sql = sql[: match.start()] + match[0] + "," + successor + sql[match.end() :]
    anchor = " THEN\n  RAISE EXCEPTION 'Unqualified schema drift: pod_chat_action_identity';"
    if sql.count(anchor) != 1:
        raise ValueError("Private-agent Browser authority object guard changed")
    sql = sql.replace(anchor, f" AND NOT {definition_match_sql(successor=True)}" + anchor, 1)
    qualification = f"""DO $qualify_browser_credential$
BEGIN
 LOCK TABLE public.one_action_directive_ledger IN ACCESS EXCLUSIVE MODE;
 IF {footprint_sql()} THEN
  {require_successor_sql()}
 END IF;
END $qualify_browser_credential$;
"""
    if len(re.findall(r"^BEGIN;[ \t]*$", sql, flags=re.M)) != 1:
        raise ValueError("Private-agent foundation transaction shape changed")
    return sql.replace("BEGIN;", "BEGIN;\n" + qualification, 1)
