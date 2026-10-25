"""Preserve qualified private-action successors without changing historical SQL."""

from __future__ import annotations

import hashlib
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.migration_authority import MigrationManifestEntryV2

SOURCES = {
    (
        "212",
        "212_location_command_runtime.sql",
    ): "c10a587ce907e5913df4eeec25a4d71ef1aa8a709d8fccccf2eb223e23448d3d",
    (
        "231",
        "231_document_review_authority.sql",
    ): "55dfd1bdff4326fdaf8eea96a72cc32685b545a2e185489f4adcd5bb95f19337",
    (
        "248",
        "248_adk_chat_action_authority.sql",
    ): "8922c7430b8fc04d4430f6e127d93605f878d402ba67ca751dbb09da41f036a7",
}
_CHANNEL = "one_action_directive_ledger_channel_check"
_CONTEXT = "one_action_directive_ledger_check"
_EXPECTED = {
    _CHANNEL: "CHECK((channel=ANY(ARRAY['typed_chat'::text,'voice'::text,'command'::text,'document_review'::text,'adk_chat'::text,'pod_chat'::text])))",
    _CONTEXT: "CHECK((((channel='typed_chat'::text)AND(conversation_idISNOTNULL)AND(session_idISNULL))OR((channel=ANY(ARRAY['voice'::text,'command'::text,'adk_chat'::text,'pod_chat'::text]))AND(session_idISNOTNULL)AND(conversation_idISNULL))OR((channel='document_review'::text)AND(conversation_idISNULL)AND(session_idISNULL))))",
    "pod_chat_action_identity": "CHECK(((channel<>'pod_chat'::text)OR((adk_app_nameISNULL)AND(action_id=ANY(ARRAY['connector.mcp.invoke'::text,'browser.model_process'::text,'browser.disclose'::text,'browser.session_remember'::text,'browser.session_restore'::text,'browser.provider_safety'::text]))ANDrequires_confirmationANDtrusted_activation_requiredAND(resource_binding_hmacISNOTNULL))))",
}
_MARKERS = ("private-action-channel.v1/971", "private-action-channel.v1/420")


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _guard(clauses: list[str]) -> str:
    expected = ",".join(f"({_literal(name)},{_literal(rule)})" for name, rule in _EXPECTED.items())
    markers = "ARRAY[" + ",".join(_literal(value) for value in _MARKERS) + "]"
    return f"""DO $private_channel$
BEGIN
 LOCK TABLE one_action_directive_ledger IN ACCESS EXCLUSIVE MODE;
 IF EXISTS (SELECT 1 FROM pg_constraint
   WHERE conrelid='one_action_directive_ledger'::regclass
    AND obj_description(oid,'pg_constraint')=ANY({markers})) THEN
  IF (SELECT count(*) FROM pg_constraint c
    JOIN (VALUES {expected}) AS expected(name,definition) ON c.conname=expected.name
    WHERE c.conrelid='one_action_directive_ledger'::regclass
     AND c.contype='c' AND c.convalidated
     AND regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=expected.definition
     AND (c.conname='pod_chat_action_identity'
       OR obj_description(c.oid,'pg_constraint')=ANY({markers}))) <> 3 THEN
   RAISE EXCEPTION 'Private action successor constraints changed; refusing historical replay';
  END IF;
 ELSE
  IF to_regclass('schema_migrations') IS NOT NULL THEN
   IF EXISTS (SELECT 1 FROM schema_migrations
      WHERE migration_id IN ('971','420') AND status='applied') THEN
    RAISE EXCEPTION 'Private action successor marker missing; refusing historical replay';
   END IF;
  END IF;
  ALTER TABLE one_action_directive_ledger {", ".join(clauses)};
 END IF;
END $private_channel$;"""


def private_action_replay_sql(entry: MigrationManifestEntryV2) -> str:
    """Adapt only four known CHECK clauses; all other DDL remains executable."""
    pinned = SOURCES[(entry.migration_id, entry.filename)]
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if checksum != pinned or entry.checksum_sha256 != checksum:
        raise ValueError("Private action replay source checksum changed")
    changed = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal changed
        clauses = re.split(r",\s*(?=(?:ADD|DROP)\s+(?:CONSTRAINT|COLUMN)\b)", match[1].strip())
        selected, retained = [], []
        for clause in clauses:
            if re.match(
                rf"(?:DROP CONSTRAINT IF EXISTS|ADD CONSTRAINT)\s+(?:{_CHANNEL}|{_CONTEXT})\b",
                clause,
            ):
                selected.append(clause)
            else:
                retained.append(clause)
        if not selected:
            return match[0]
        changed += len(selected)
        rest = (
            "\nALTER TABLE one_action_directive_ledger " + ",\n  ".join(retained) + ";"
            if retained
            else ""
        )
        return _guard(selected) + rest

    result = re.sub(
        r"ALTER TABLE one_action_directive_ledger\s+(.*?);", replace, entry.sql, flags=re.DOTALL
    )
    if changed != 4:
        raise ValueError("Private action replay source shape changed")
    return result
