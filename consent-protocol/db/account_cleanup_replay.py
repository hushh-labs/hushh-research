"""Preserve qualified cleanup/generation functions during historical replay.

Only pinned bootstrap statements and cleanup function/trigger successors are
adapted. The remaining historical DDL still executes. A successor must match its qualified definition; an absent or
changed successor refuses replay rather than restoring the older behavior.
"""

from __future__ import annotations

import hashlib
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.migration_authority import MigrationManifestEntryV2

SOURCES = {
    (
        "201",
        "201_account_deletion_tombstones.sql",
    ): "19f3fb215d7f67246b9b580c9f65ebdd9ed9efa0ceb0880ffb45f055423e3b14",
    (
        "290",
        "290_chat_push_delivery.sql",
    ): "cca2de913441cd1b658acb7161f043b4fe51fa4bd7cfbd36ea911656c54cffb4",
    (
        "370",
        "370_one_marketing_preferences.sql",
    ): "b16f9e5ce261749b94d2d17e6b4350b0b76d228c6855c7a3da116c9e0ce4c349",
}
_BOOTSTRAP_SOURCES = {
    (
        "020",
        "020_ria_iam_foundation.sql",
    ): "12917d6e525bee0510e0f2d24323784c5bef4628a3fbaf3a5f12063a1a629757",
    (
        "021",
        "021_runtime_persona_state.sql",
    ): "c548cafeff79ee1f2f69a04d9cf17ef539d0ac02166e22c23970040f823dd49e",
    (
        "037",
        "037_actor_identity_cache.sql",
    ): "7c466e87fefc4a1f3157c95ce1e12c43ac1ef51aaf1ed1e7b678c1ed2531c306",
}
_CREDENTIAL_BACKFILLS = {
    (
        "046",
        "046_kai_gmail_receipt_total.sql",
    ): "2ac8585e817aafa4f0c1a66f6650fb5f97288b374f4848a84d1213172ce82ef7",
    (
        "208",
        "208_gmail_authorized_send_enablement_backfill.sql",
    ): "760fb06a293fcd96f88e1bc5fb8e544b0999b40fbc2a008dbfcdc1e3a5d980a5",
}
_BOOTSTRAP_SOURCES.update(
    {
        (
            "036",
            "036_relationship_share_grants.sql",
        ): "ded111895ef5a9517d0b26e5d911550d14a1ffc96757a5c15ed74f1800fd485c",
        (
            "043",
            "043_ria_pick_share_artifacts.sql",
        ): "c2536bd77f15d46a6ea6fc63d23daa41d95bed6ab7fce7f0c5c17bd1a782e9eb",
        (
            "079",
            "079_unify_location_connections.sql",
        ): "586dee40bae44934863939d8305a4c40bb5bc2ace556414266f4a0a4e55828e2",
        (
            "087",
            "087_scope_policy_v2.sql",
        ): "9bbaa6653f55b33c4d80b2b753b65e06e3ac2087db4f4513d969a9b52a55efbc",
        (
            "135",
            "135_one_location_circle_connection_origins.sql",
        ): "1d876753e329bf7da3dcc40d7fbef6ea7810d0a191d6b62c8ef5322dcb581e26",
        (
            "142",
            "142_source_library_scope_retirement.sql",
        ): "d8561eaa69132078943e00a256e9fc8b7655a079a764505f59d2bfac2a384359",
        (
            "234",
            "234_drive_permission_management_retention.sql",
        ): "5ca203207e31fa1b7e7b247450e6899d2ca01bee8cde02cc4a4c58391c996513",
        (
            "347",
            "347_one_referral_dashboard_lifecycle.sql",
        ): "2036301cdae30b7786a568b41635d5b331e542bb132677dafb4f3227bfe11279",
    }
)
SOURCES.update(_BOOTSTRAP_SOURCES)
SOURCES.update(_CREDENTIAL_BACKFILLS)

_SUCCESSORS = {
    "record_account_deletion_tombstone": "92205d90a16724cb38b5559a1e5ee0aabc0c56e90a720072a010245068317e20",
    "refresh_account_deletion_guards_after_identity_ddl": "439bf9370a93bf722212d595fcec30d45f81605656719cc791099506cb1a3c0b",
    "erase_tombstoned_push_registrations": "a56d98378908089c602ce63fd27ad19e41440b0d5c897e741a225010dd545b15",
    "erase_one_marketing_preference": "50d7250f8d4ff657cf524c715d0d354d2efefe31542f0756e960539a09f63109",
}
_OWNED = {
    "201": (
        "record_account_deletion_tombstone",
        "refresh_account_deletion_guards_after_identity_ddl",
    ),
    "290": ("erase_tombstoned_push_registrations",),
    "370": ("erase_one_marketing_preference",),
}

_TRIGGER_SUCCESSORS = {
    "push_account_erased": "26e15abae739169902e5a0dd6437ea7aeac233393386cdf655c20c26d1345d86",
    "one_marketing_erasure": "0bfa63ce6277dcba9d550cc82e2d6383725b1e4d83d6d67959ec53643b45bcd3",
}


def _guard(name: str, legacy: str) -> str:
    if "$account_legacy$" in legacy:
        raise ValueError("Account replay delimiter conflicts with pinned source")
    installed = (
        "EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.account_deletion_tombstones') AND attname='generation_retired_at' AND NOT attisdropped) OR to_regclass('public.account_generations') IS NOT NULL OR to_regclass('public.account_firebase_mutations') IS NOT NULL"
        if name == "refresh_account_deletion_guards_after_identity_ddl"
        else "EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.account_deletion_tombstones') AND attname='erasure_phase' AND NOT attisdropped)"
    )
    return f"""DO $account_replay$
DECLARE observed text;
BEGIN
 IF {installed} THEN
  IF to_regprocedure('public.account_provider_cleanup_pending(text)') IS NULL THEN RAISE EXCEPTION 'Account lifecycle successor missing'; END IF;
  SELECT pg_get_functiondef(to_regprocedure('public.{name}()')) INTO observed;
  IF observed IS NULL OR encode(sha256(convert_to(observed,'UTF8')),'hex')<>'{_SUCCESSORS[name]}' THEN
   RAISE EXCEPTION 'Account lifecycle successor changed; refusing historical replay';
  END IF;
 ELSE
  EXECUTE $account_legacy${legacy}$account_legacy$;
 END IF;
END
$account_replay$;"""


def _trigger_guard(name: str, legacy: str) -> str:
    return f"""DO $account_trigger_replay$
DECLARE observed text; original_path text := current_setting('search_path');
BEGIN
 PERFORM set_config('search_path','pg_catalog,public',true);
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.account_deletion_tombstones') AND attname='erasure_phase' AND NOT attisdropped) THEN
  IF to_regprocedure('public.account_provider_cleanup_pending(text)') IS NULL THEN RAISE EXCEPTION 'Account lifecycle successor missing'; END IF;
  SELECT pg_get_triggerdef(oid,true) INTO observed FROM pg_trigger
   WHERE tgrelid='public.account_deletion_tombstones'::regclass AND tgname='{name}' AND tgenabled='O';
  IF observed IS NULL OR encode(sha256(convert_to(observed,'UTF8')),'hex')<>'{_TRIGGER_SUCCESSORS[name]}' THEN
   RAISE EXCEPTION 'Account lifecycle trigger changed; refusing historical replay';
  END IF;
 ELSE
  EXECUTE $account_legacy${legacy}$account_legacy$;
 END IF;
 PERFORM set_config('search_path',original_path,true);
END
$account_trigger_replay$;"""


def _eligible(owner: str) -> str:
    return (
        "NOT EXISTS(SELECT 1 FROM public.account_deletion_tombstones lifecycle "
        "WHERE lifecycle.user_id_hash='sha256:'||encode(sha256(convert_to("
        + owner
        + ",'UTF8')),'hex'))"
    )


def _bootstrap(sql: str, version: str) -> str:
    """Filter only the captured identities in checksum-pinned historical seeds."""
    rule: dict[str, list[tuple[str, str, int]]] = {
        "020": [
            (
                "FROM vault_keys\nON CONFLICT (user_id) DO NOTHING;",
                "FROM vault_keys\nWHERE "
                + _eligible("vault_keys.user_id")
                + "\nON CONFLICT (user_id) DO NOTHING;",
                1,
            )
        ],
        "021": [
            (
                "-- Seed missing fallback state; an existing row belongs to the runtime.\nON CONFLICT",
                "WHERE "
                + _eligible("vk.user_id")
                + "\n-- Seed missing fallback state; an existing row belongs to the runtime.\nON CONFLICT",
                1,
            )
        ],
        "037": [
            (
                "ON CONFLICT (user_id) DO UPDATE SET",
                "WHERE " + _eligible("ap.user_id") + "\nON CONFLICT (user_id) DO UPDATE SET",
                1,
            )
        ],
        "036": [
            (
                "WHERE rel.status = 'approved'",
                "WHERE rel.status = 'approved' AND "
                + _eligible("rp.user_id")
                + " AND "
                + _eligible("rel.investor_user_id"),
                1,
            )
        ],
        "043": [
            (
                "WHERE rel.status = 'approved'",
                "WHERE rel.status = 'approved' AND "
                + _eligible("rp.user_id")
                + " AND "
                + _eligible("rel.investor_user_id"),
                1,
            )
        ],
        "079": [
            (
                "AND COALESCE(nc.metadata->>'source', '') <> 'sos_seed'",
                "AND COALESCE(nc.metadata->>'source', '') <> 'sos_seed' AND "
                + _eligible("nc.user_a_id")
                + " AND "
                + _eligible("nc.user_b_id"),
                2,
            )
        ],
        "087": [
            (
                "FROM retired_live_grants;",
                "FROM retired_live_grants WHERE " + _eligible("user_id") + ";",
                1,
            )
        ],
        # Replay can encounter retained Circle memberships after erasure. Filter
        # both backfills before INSERT triggers run, including ON CONFLICT paths.
        "135": [
            (
                "AND to_jsonb(circle) ->> 'system_kind' IS DISTINCT FROM 'trusted'",
                "AND to_jsonb(circle) ->> 'system_kind' IS DISTINCT FROM 'trusted' AND "
                + _eligible("first_member.user_id")
                + " AND "
                + _eligible("second_member.user_id"),
                2,
            )
        ],
        "142": [
            (
                "FROM live_authorities;",
                "FROM live_authorities WHERE " + _eligible("user_id") + ";",
                1,
            ),
            (
                "FROM pending_requests;",
                "FROM pending_requests WHERE " + _eligible("user_id") + ";",
                1,
            ),
        ],
        "234": [
            (
                "FROM drive_share_requests\n  ON CONFLICT",
                "FROM drive_share_requests WHERE "
                + _eligible("drive_share_requests.user_id")
                + "\n  ON CONFLICT",
                1,
            )
        ],
        "347": [
            (
                "WHERE NOT EXISTS (SELECT 1 FROM one_referral_relationships p WHERE p.referred_user_id = r.referrer_user_id)\n ON CONFLICT DO NOTHING;",
                "WHERE NOT EXISTS (SELECT 1 FROM one_referral_relationships p WHERE p.referred_user_id = r.referrer_user_id) AND "
                + _eligible("r.referrer_user_id")
                + "\n ON CONFLICT DO NOTHING;",
                1,
            ),
            (
                "SELECT leader_user_id,id FROM one_referral_network_circles ON CONFLICT DO NOTHING;",
                "SELECT leader_user_id,id FROM one_referral_network_circles WHERE "
                + _eligible("leader_user_id")
                + " ON CONFLICT DO NOTHING;",
                1,
            ),
            (
                "WHERE NOT r.referred_user_id = ANY(n.path)\n)\nINSERT INTO one_referral_network_members",
                "WHERE NOT r.referred_user_id = ANY(n.path) AND "
                + _eligible("r.referred_user_id")
                + " AND "
                + _eligible("r.referrer_user_id")
                + "\n)\nINSERT INTO one_referral_network_members",
                1,
            ),
        ],
    }
    filtered = sql
    for anchor, replacement, expected in rule[version]:
        if filtered.count(anchor) != expected:
            raise ValueError("Account bootstrap replay source shape changed")
        filtered = filtered.replace(anchor, replacement)

    def body(value: str) -> str:
        value, begins = re.subn(r"^BEGIN;[ \t]*$", "", value, flags=re.MULTILINE)
        value, commits = re.subn(r"^COMMIT;[ \t]*$", "", value, flags=re.MULTILINE)
        if (
            begins != commits
            or begins not in (0, 1)
            or "$bootstrap_legacy$" in value
            or "$bootstrap_current$" in value
        ):
            raise ValueError("Account bootstrap transaction source changed")
        return value

    return (
        "BEGIN;\nDO $bootstrap_replay$\nBEGIN\n"
        " IF to_regclass('public.account_deletion_tombstones') IS NULL THEN\n"
        " EXECUTE $bootstrap_legacy$" + body(sql) + "$bootstrap_legacy$;\n ELSE\n"
        " EXECUTE $bootstrap_current$" + body(filtered) + "$bootstrap_current$;\n END IF;\n"
        "END\n$bootstrap_replay$;\nCOMMIT;"
    )


def _credential_backfill(sql: str, version: str) -> str:
    anchor = (
        "WHERE connections.user_id = receipt_counts.user_id;"
        if version == "046"
        else "WHERE status = 'connected'"
    )
    filtered = (
        anchor.removesuffix(";")
        + " AND NOT public.account_provider_cleanup_pending(connections.user_id);"
        if version == "046"
        else anchor
        + " AND NOT public.account_provider_cleanup_pending(kai_gmail_connections.user_id)"
    )
    if sql.count(anchor) != 1:
        raise ValueError("Credential backfill replay source shape changed")
    current = sql.replace(anchor, filtered)

    def body(value: str) -> str:
        value = re.sub(r"^BEGIN;[ \t]*$", "", value, flags=re.MULTILINE)
        return re.sub(r"^COMMIT;[ \t]*$", "", value, flags=re.MULTILINE)

    if "$credential_legacy$" in sql or "$credential_current$" in sql:
        raise ValueError("Credential replay delimiter conflicts with pinned source")
    return (
        "BEGIN;\nDO $credential_replay$\nBEGIN\n"
        " IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.account_deletion_tombstones') AND attname='erasure_phase' AND NOT attisdropped) THEN\n"
        " IF to_regprocedure('public.account_provider_cleanup_pending(text)') IS NULL THEN RAISE EXCEPTION 'Account lifecycle successor missing'; END IF;\n"
        " EXECUTE $credential_current$" + body(current) + "$credential_current$;\n ELSE\n"
        " EXECUTE $credential_legacy$" + body(sql) + "$credential_legacy$;\n END IF;\n"
        "END\n$credential_replay$;\nCOMMIT;"
    )


def account_cleanup_replay_sql(
    entry: MigrationManifestEntryV2, *, qualified_referral_sql: str | None = None
) -> str:
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != SOURCES[(entry.migration_id, entry.filename)]
        or checksum != entry.checksum_sha256
    ):
        raise ValueError("Account lifecycle replay source checksum changed")
    if (entry.migration_id, entry.filename) in _CREDENTIAL_BACKFILLS:
        return _credential_backfill(entry.sql, entry.migration_id)
    if entry.migration_id == "347":
        if qualified_referral_sql is None:
            raise ValueError("Qualified referral successor required before lifecycle filtering")
        return _bootstrap(qualified_referral_sql, entry.migration_id)
    if qualified_referral_sql is not None:
        raise ValueError("Unexpected qualified referral source")
    if (entry.migration_id, entry.filename) in _BOOTSTRAP_SOURCES:
        return _bootstrap(entry.sql, entry.migration_id)
    sql = entry.sql
    for name in _OWNED[entry.migration_id]:
        pattern = re.compile(
            rf"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?{name}\(\)"
            r"\s+RETURNS\b.*?\bAS\s+(?P<tag>\$(?:[\w]+)?\$).*?(?P=tag)"
            r"\s*(?:LANGUAGE\s+[^;]+)?;",
            re.IGNORECASE | re.DOTALL,
        )

        def preserve_function(match: re.Match[str], function_name: str = name) -> str:
            return _guard(function_name, match[0])

        sql, count = pattern.subn(preserve_function, sql)
        if count != 1:
            raise ValueError("Account lifecycle replay source shape changed")
    trigger = {"290": "push_account_erased", "370": "one_marketing_erasure"}.get(entry.migration_id)
    if trigger:
        pattern = re.compile(
            rf"DROP TRIGGER IF EXISTS {trigger} ON (?:public\.)?account_deletion_tombstones;"
            rf"\s*CREATE TRIGGER {trigger}\b.*?EXECUTE FUNCTION [^;]+;",
            re.IGNORECASE | re.DOTALL,
        )
        sql, count = pattern.subn(lambda match: _trigger_guard(trigger, match[0]), sql)
        if count != 1:
            raise ValueError("Account lifecycle trigger source shape changed")
    return sql
