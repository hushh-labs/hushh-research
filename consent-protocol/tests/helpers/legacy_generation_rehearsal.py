"""Legacy erasure acceptance (437, UAT overlay 438) in the real PostgreSQL deletion gate."""

from __future__ import annotations

import hashlib
import re
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

import psycopg2
import pytest
from psycopg2.extras import RealDictCursor

from hushh_mcp.services import account_generation_service as generations

MIGRATIONS = Path(__file__).resolve().parents[2] / "db/migrations"
CANONICAL = "437_account_legacy_generation_settlement.sql"
UAT_OVERLAY = "438_uat_legacy_generation_settlement.sql"
FUNCTIONS = (
    "account_legacy_cleanup_reference(text,integer)",
    "account_legacy_provider_custody_absent(text)",
    "account_legacy_cleanup_settleable(public.account_generations)",
    "settle_legacy_account_generation(text)",
)
# Legacy identity-cleanup outcomes exactly as UAT recorded them.
RETAINED = ("quarantined", "identity_retained", "firebase_shared_identity_retained")
BACKEND_ONLY = ("completed", None, "uat_backend_only_erasure")
DELETED = ("completed", "deleted", None)
ABSENT = ("completed", "not_found", "firebase_user_not_found")
NEAR_MISS = ("completed", "deleted", "firebase_user_not_found")
RETRYING = ("retry_pending", "quarantine_incomplete", "firebase_authority_mismatch")
KEPT = ("kept-backend-only", "kept-retained")
REFUSED = (
    "gone-deleted",
    "gone-absent",
    "near-miss",
    "holds-credentials",
    "still-retrying",
    "unsettled-write",
)
HISTORY = (
    ("kept-backend-only", BACKEND_ONLY, None),
    ("kept-retained", RETAINED, None),
    ("gone-deleted", DELETED, None),
    ("gone-absent", ABSENT, None),
    ("near-miss", NEAR_MISS, None),
    ("holds-credentials", RETAINED, None),
    ("other-identity", RETAINED, "other-firebase-uid"),
    ("still-retrying", RETRYING, "still-retrying"),
    ("unsettled-write", RETAINED, None),
)
# Custody tables carry no cascade: an erased owner's residual row must survive.
NEIGHBOURS = """
CREATE TABLE IF NOT EXISTS actor_profiles(user_id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS one_adk_sessions(user_id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS vault_keys(user_id text PRIMARY KEY);
CREATE TABLE user_push_tokens(id bigserial PRIMARY KEY, user_id text, token text, platform text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE(user_id,platform));
CREATE TABLE conversations(id uuid PRIMARY KEY, participant_a_user_id text,
    participant_b_user_id text);
CREATE TABLE messages(id uuid PRIMARY KEY, conversation_id uuid, sender_user_id text);
CREATE TABLE circle_chat_recipients(push_due_at timestamptz);
CREATE TABLE circle_chat_messages(id uuid PRIMARY KEY);
CREATE TABLE external_connector_oauth_attempts(attempt_id text PRIMARY KEY, user_id text,
    pending_credential_ciphertext text, pending_credential_iv text);
CREATE TABLE kai_gmail_connections(user_id text PRIMARY KEY, refresh_token_ciphertext text,
    watch_status text);
CREATE TABLE user_external_connector_connections(user_id text, connector_id text, status text,
    credential_ciphertext text, credential_iv text, credential_algorithm text,
    connection_generation bigint DEFAULT 0, credential_version bigint DEFAULT 0,
    envelope_version integer DEFAULT 2, connected_at timestamptz, pending_attempt_id text,
    revocation_outcome text DEFAULT 'not_attempted', PRIMARY KEY(user_id,connector_id));
CREATE TABLE connected_documents(user_id text, connector_id text);
CREATE TABLE drive_picker_sessions(user_id text, connector_id text, session_id text);
CREATE TABLE drive_native_picker_attempts(user_id text, connector_id text,
    selection_session_id text);
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','legacy_public_probe'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
  END IF;
 END LOOP;
END $$;
"""


def digest(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def reference(identity: str) -> str:
    """Independent UUIDv8 derivation of account_legacy_cleanup_reference(identity_hash, 0)."""
    terms = f"hussh-legacy-account-cleanup/v1|{digest(identity)}|0".encode()
    raw = bytearray(hashlib.sha256(terms).digest()[:16])
    raw[6] = (raw[6] & 0x0F) | 0x80
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(UUID(bytes=bytes(raw)))


@contextmanager
def legacy_database(database_url: str):
    """One disposable database on the module's disposable cluster."""
    name = f"legacy_{uuid4().hex[:12]}"
    admin = psycopg2.connect(database_url)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    conn = psycopg2.connect(
        database_url.replace("/postgres?", f"/{name}?"), cursor_factory=RealDictCursor
    )
    conn.autocommit = True
    try:
        yield conn
    finally:
        conn.close()
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.close()


def run(conn, sql: str, params=None) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall()) if cur.description else []


def apply(conn, *names: str) -> None:
    for name in names:
        run(conn, (MIGRATIONS / name).read_text())


def generation(conn, identity: str) -> dict:
    return run(
        conn,
        "SELECT * FROM account_generations WHERE identity_hash=%s ORDER BY generation DESC LIMIT 1",
        (digest(identity),),
    )[0]


def settle(conn, identity: str) -> bool:
    return run(
        conn, "SELECT public.settle_legacy_account_generation(%s) AS ok", (digest(identity),)
    )[0]["ok"]


def tombstones(conn) -> list:
    return [
        row["t"]
        for row in run(
            conn, "SELECT to_jsonb(t) AS t FROM account_deletion_tombstones t ORDER BY 1"
        )
    ]


def assert_custody_sources_match_418() -> None:
    source_418 = (MIGRATIONS / "418_account_provider_cleanup_staging.sql").read_text()
    inventory = source_418[
        source_418.index("account_provider_cleanup_live_inventory(owner_id text)") :
    ]
    expected = set(re.findall(r"\('([a-z_]+)','[a-z_]+'\)", inventory[: inventory.index("LOOP")]))
    canonical = (MIGRATIONS / CANONICAL).read_text()
    listed = canonical[canonical.index("FOREACH source IN ARRAY ARRAY[") :]
    assert set(re.findall(r"'([a-z_]+)'", listed[: listed.index("] LOOP")])) == expected


def seed_legacy_history(conn) -> None:
    """Pre-418 erasure history, frozen by 418/419 exactly as the releases did."""
    run(conn, NEIGHBOURS)
    picker = (MIGRATIONS / "236_drive_native_picker_attempts.sql").read_text()
    run(
        conn,
        picker[
            picker.index(
                "CREATE OR REPLACE FUNCTION invalidate_selected_drive_documents()"
            ) : picker.index("ALTER TABLE drive_native_picker_attempts ENABLE ROW LEVEL SECURITY")
        ],
    )
    apply(
        conn,
        "201_account_deletion_tombstones.sql",
        "144_google_integrations_calendar_foundation.sql",
        "290_chat_push_delivery.sql",
        "359_independent_email_otp.sql",
        "370_one_marketing_preferences.sql",
    )
    # A credential written before erasure and never removed.
    run(conn, "INSERT INTO kai_gmail_connections(user_id) VALUES('holds-credentials')")
    for owner, (status, outcome, classification), firebase_uid in HISTORY:
        run(
            conn,
            """INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid,cleanup_status,
            cleanup_last_outcome,cleanup_last_classification,cleanup_next_attempt_at,deleted_at,
            updated_at) VALUES(%s,%s,%s,%s,%s,CASE WHEN %s='retry_pending'
            THEN now()+interval '1 hour' END,now()-interval '7 days',now()-interval '7 days')""",
            (digest(owner), firebase_uid, status, outcome, classification, status),
        )
    apply(
        conn,
        "418_account_provider_cleanup_staging.sql",
        "419_account_generations.sql",
        "423_account_shared_provider_authority.sql",
        "427_workos_generation_memberships.sql",
    )
    # The identity cleanup ends in the exact retained shape, but the owner is not the identity.
    run(
        conn,
        "UPDATE account_deletion_tombstones SET firebase_uid=NULL WHERE user_id_hash=%s",
        (digest("other-identity"),),
    )
    run(
        conn,
        """INSERT INTO account_firebase_mutations(operation_id,owner_hash,identity_hash,
        authority_project,purpose,settlement_nonce) VALUES(gen_random_uuid(),%s,%s,'hushh-pda',
        'display_name',gen_random_uuid())""",
        (digest("unsettled-write"), digest("unsettled-write")),
    )
    run(
        conn,
        """INSERT INTO account_generations(identity_hash,generation,owner_hash,owner_id,identity_uid)
        VALUES(%s,0,%s,'active','active')""",
        (digest("active"), digest("active")),
    )


def assert_current_main_refuses(conn) -> None:
    """Before 437 the same history is a permanent dead end."""
    for identity in KEPT:
        row = generation(conn, identity)
        assert generations.replacement_review(
            identity, row, authenticated_at=int(time.time()) - 5, mutations_settled=True
        ) == {"state": "action_required", "reason": "historical_cleanup_unconfirmed"}
        assert enroll(conn, identity, reference(identity)) is None
        with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="immutable"):
            run(
                conn,
                """UPDATE account_generations SET cleanup_confirmed=true,cleanup_operation=%s
                WHERE identity_hash=%s""",
                (reference(identity), digest(identity)),
            )


def assert_settlement_refused(conn) -> None:
    """The writer itself refuses, whatever candidates a caller selects."""
    for identity in (*REFUSED, "other-firebase-uid", "active", "never-deleted"):
        assert settle(conn, identity) is False, identity
    assert_unsettled(conn, *REFUSED)


def enroll(conn, identity: str, cleanup: str, *, enrollment=None, authenticated_at=None):
    return run(
        conn,
        "SELECT public.enroll_account_generation(%s,0,%s,%s,%s) AS owner",
        (identity, cleanup, enrollment or str(uuid4()), authenticated_at or int(time.time()) - 5),
    )[0]["owner"]


def assert_unsettled(conn, *identities: str) -> None:
    for identity in identities:
        row = generation(conn, identity)
        assert (row["cleanup_confirmed"], row["cleanup_operation"]) == (False, None), identity
    other = run(
        conn, "SELECT * FROM account_generations WHERE owner_hash=%s", (digest("other-identity"),)
    )
    assert (other[0]["cleanup_confirmed"], other[0]["cleanup_operation"]) == (False, None)
    assert generation(conn, "active")["retired_at"] is None


def assert_kept_identities_start_fresh(conn, before: list) -> None:
    for identity in KEPT:
        row = generation(conn, identity)
        sql_reference = run(
            conn,
            "SELECT public.account_legacy_cleanup_reference(%s,0)::text AS ref",
            (digest(identity),),
        )[0]["ref"]
        assert row["cleanup_confirmed"] is True
        assert str(row["cleanup_operation"]) == sql_reference == reference(identity)
        assert UUID(sql_reference).version == 8
        stale = generations.replacement_review(
            identity, row, authenticated_at=1, mutations_settled=True
        )
        assert stale == {"state": "fresh_identity_required"}
        ready = generations.replacement_review(
            identity, row, authenticated_at=int(time.time()) - 5, mutations_settled=True
        )
        assert ready["state"] == "ready" and ready["review"]["cleanup_operation"] == reference(
            identity
        )
    assert enroll(conn, "kept-backend-only", str(uuid4())) is None
    enrollment, authenticated_at = str(uuid4()), int(time.time()) - 5
    owner = enroll(
        conn,
        "kept-retained",
        reference("kept-retained"),
        enrollment=enrollment,
        authenticated_at=authenticated_at,
    )
    assert owner["generation"] == 1 and re.fullmatch(r"acct_[0-9a-f]{32}", owner["owner_id"])
    assert (
        enroll(
            conn,
            "kept-retained",
            reference("kept-retained"),
            enrollment=enrollment,
            authenticated_at=authenticated_at,
        )
        == owner
    )
    assert tombstones(conn) == before  # Acceptance never rewrites erasure history.
    assert settle(conn, "kept-backend-only") is False
    for statement in (
        "UPDATE account_generations SET cleanup_confirmed=false WHERE identity_hash=%s",
        "DELETE FROM account_generations WHERE identity_hash=%s",
    ):
        with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="immutable"):
            run(conn, statement, (digest("kept-backend-only"),))


def refuse_update(conn, target: str, context: str, assignment: str, *values) -> None:
    run(conn, "SELECT set_config('hussh.account_legacy_settlement',%s,false)", (context,))
    try:
        with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="immutable"):
            run(
                conn,
                f"UPDATE account_generations SET {assignment} WHERE identity_hash=%s",
                (*values, target),
            )
    finally:
        run(conn, "SELECT set_config('hussh.account_legacy_settlement','',false)")


def assert_guard_bypass_controls(conn) -> None:
    """Each refusal isolates one guard clause and fails if that clause is removed."""
    identity, target = "holds-credentials", digest("holds-credentials")
    exact, confirm = reference(identity), "cleanup_confirmed=true,cleanup_operation=%s"
    refuse_update(conn, target, target, confirm, exact)  # Custody remains: not settleable.
    run(conn, "DELETE FROM kai_gmail_connections WHERE user_id=%s", (identity,))
    refuse_update(conn, target, "", confirm, exact)  # No settlement context.
    refuse_update(
        conn, target, target, "cleanup_confirmed=true,cleanup_operation=gen_random_uuid()"
    )
    refuse_update(conn, target, target, f"{confirm},admitted_after=admitted_after+1", exact)
    refuse_update(conn, target, target, "cleanup_confirmed=false,cleanup_operation=%s", exact)
    assert_unsettled(conn, identity)
    assert settle(conn, identity) is True and settle(conn, identity) is False
    assert str(generation(conn, identity)["cleanup_operation"]) == exact
    refuse_update(conn, target, target, confirm, exact)  # Settled history is immutable.


def assert_replay_and_late_settlement(conn) -> None:
    """Replay order 419 -> 437 -> 438 keeps settlements and settles late outcomes."""
    guard = "SELECT md5(pg_get_functiondef('public.guard_account_generation_history()'::regprocedure)) AS h"
    accepted = run(conn, guard)[0]["h"]
    apply(conn, "419_account_generations.sql")
    assert run(conn, guard)[0]["h"] != accepted
    assert generation(conn, "kept-backend-only")["cleanup_confirmed"] is True
    # What the legacy cleanup worker records when it retains the identity.
    run(
        conn,
        """UPDATE account_deletion_tombstones SET firebase_uid=NULL,cleanup_status='quarantined',
        cleanup_next_attempt_at=NULL,cleanup_last_outcome='identity_retained',
        cleanup_last_classification='firebase_shared_identity_retained',updated_at=now()
        WHERE user_id_hash=%s""",
        (digest("still-retrying"),),
    )
    apply(conn, CANONICAL)
    assert run(conn, guard)[0]["h"] == accepted
    assert generation(conn, "still-retrying")["cleanup_confirmed"] is False
    apply(conn, UAT_OVERLAY)
    assert str(generation(conn, "still-retrying")["cleanup_operation"]) == reference(
        "still-retrying"
    )


def assert_privileges(conn) -> None:
    for role in ("anon", "authenticated", "service_role", "legacy_public_probe"):
        for function in FUNCTIONS:
            granted = run(
                conn,
                "SELECT has_function_privilege(%s,%s,'EXECUTE') AS ok",
                (role, f"public.{function}"),
            )[0]["ok"]
            assert granted is False, (role, function)
