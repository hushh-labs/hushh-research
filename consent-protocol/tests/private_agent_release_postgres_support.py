"""Synthetic retained-state checks for canonical private-agent graduation."""

import asyncio
import json
from uuid import uuid4

from db.migration_authority import _replay_sql, build_manifest_entries
from tests.standby_postgres_support import seed_primary


def apply_release_successors(conn, cp, *, retained_consumer=False):
    from db import migrate
    from tests.consumer_consent_replay_support import (
        install_consumer_predecessor,
        seed_consumer_connections,
    )

    with conn.cursor() as cur:
        if retained_consumer:
            install_consumer_predecessor(cur.execute)
            seed_consumer_connections(cur.execute)
            cur.execute("SELECT to_jsonb(c) FROM consumer_mcp_connections c ORDER BY connection_id")
            before = cur.fetchall()
        files = [name for name in migrate.RELEASE_MIGRATION_FILES if int(name[:3]) > 417]
        for entry in build_manifest_entries(cp / "db/migrations", files):
            if retained_consumer and entry.migration_id == "420":
                import psycopg2
                import pytest

                with pytest.raises(
                    psycopg2.errors.RaiseException, match="Unqualified private-agent triggers"
                ):
                    cur.execute(entry.sql)
                cur.execute("ROLLBACK")
            cur.execute(_replay_sql(entry))
        if retained_consumer:
            cur.execute("SELECT to_jsonb(c) FROM consumer_mcp_connections c ORDER BY connection_id")
            assert cur.fetchall() == before


def verify_release_contract(guard, cp, name):
    contract = json.loads((cp / "db/contracts" / (name + ".json")).read_text())
    _report, violations = asyncio.run(guard._run_db_contract_check(contract))
    assert not violations, violations


def verify_retained_release_records(conn, cp):
    def execute(sql, params=None):
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []

    class LocalPg:
        def execute(self, sql, params=None):
            return execute(sql, params)

    owners = ("synthetic-release-shared", "synthetic-release-pod", "synthetic-release-cleanup")
    for owner in owners:
        execute(
            "INSERT INTO vault_keys(user_id,vault_status,created_at,updated_at) VALUES(%s,'placeholder',0,0)",
            (owner,),
        )
        execute("INSERT INTO actor_profiles(user_id) VALUES(%s)", (owner,))
    execute(
        "UPDATE vault_keys SET one_hosting_choice='shared',one_hosting_choice_at=now() WHERE user_id=%s",
        (owners[0],),
    )
    seed_primary(LocalPg(), owner=owners[1])
    assert execute("SELECT personal_agent_cloud_removal_ready()")[0][0] is True, (
        "CLOUD_REMOVAL_SCHEMA_NOT_READY"
    )
    digest = execute(
        "SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM personal_agent_registry p WHERE user_id=%s",
        (owners[1],),
    )[0][0]
    reserved = execute("SELECT reserve_personal_agent_cloud_removal(%s,%s)", (owners[1], digest))[
        0
    ][0]
    assert reserved and reserved["phase"] == "reserved", "EXACT_CLOUD_REMOVAL_RESERVATION_REFUSED"
    attempt = reserved["attemptId"]
    execute(
        "INSERT INTO one_action_directive_ledger(directive_id,user_id,channel,session_id,action_id,context_revision,action_contract_digest,slots_hmac,resource_binding_hmac,requires_confirmation,trusted_activation_required,expires_at) VALUES('synthetic-release-review',%s,'pod_chat','synthetic-session','browser.model_process','synthetic','synthetic','synthetic','synthetic',true,true,now()+interval '5 minutes')",
        (owners[1],),
    )
    execute(
        "INSERT INTO pkm_blobs(user_id,domain,segment_id,ciphertext,iv,tag) VALUES(%s,'synthetic','primary','synthetic-ciphertext-fixture','synthetic-iv-fixture','synthetic-tag-fixture')",
        (owners[0],),
    )
    execute(
        "INSERT INTO user_push_tokens(user_id,token,platform) VALUES(%s,'synthetic-notification-fixture','web')",
        (owners[2],),
    )
    execute(
        "INSERT INTO one_marketing_preferences(user_id,user_hash,enabled,disclosure_version,surface) VALUES(%s,'sha256:'||encode(sha256(convert_to(%s,'UTF8')),'hex'),false,'one-email-updates-v1','account')",
        (owners[2], owners[2]),
    )
    execute(
        "INSERT INTO kai_gmail_connections(user_id,status,receipt_total,refresh_token_ciphertext,refresh_token_iv,refresh_token_tag) VALUES(%s,'connected',7,'synthetic-retained-envelope','synthetic-iv','synthetic-tag')",
        (owners[2],),
    )
    # Restore a synthetic pre-cutover receipt; current application writes remain blocked.
    execute("ALTER TABLE kai_gmail_receipts DISABLE TRIGGER block_kai_gmail_receipts_writes")
    try:
        execute(
            "INSERT INTO kai_gmail_receipts(user_id,gmail_message_id) VALUES(%s,'synthetic-legacy-receipt')",
            (owners[2],),
        )
    finally:
        execute("ALTER TABLE kai_gmail_receipts ENABLE TRIGGER block_kai_gmail_receipts_writes")
    for token, scope, action in (
        ("synthetic-retired-grant", "portfolio.read", "CONSENT_GRANTED"),
        ("synthetic-private-grant", "attr.source_library", "CONSENT_GRANTED"),
        ("synthetic-private-request", "attr.source_library", "REQUESTED"),
    ):
        execute(
            "INSERT INTO consent_audit(token_id,user_id,agent_id,scope,action,issued_at,request_id) VALUES(%s,%s,'synthetic-agent',%s,%s,0,%s)",
            (token, owners[2], scope, action, token),
        )
    execute(
        "INSERT INTO one_referral_network_circles(leader_user_id) VALUES(%s) ON CONFLICT DO NOTHING",
        (owners[2],),
    )
    execute(
        "INSERT INTO one_referral_network_members(user_id,circle_id) SELECT leader_user_id,id FROM one_referral_network_circles WHERE leader_user_id=%s ON CONFLICT DO NOTHING",
        (owners[2],),
    )
    operation = str(uuid4())
    execute(
        "INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid,account_owner_id,provider_cleanup_id,provider_cleanup_inventory) VALUES('sha256:'||encode(sha256(convert_to(%s,'UTF8')),'hex'),%s,%s,%s,'{}'::jsonb)",
        (owners[2], owners[2], owners[2], operation),
    )
    queries = {
        "shared_choice": ("SELECT to_jsonb(v) FROM vault_keys v WHERE user_id=%s", (owners[0],)),
        "pod_registry": (
            "SELECT to_jsonb(v) FROM personal_agent_registry v WHERE user_id=%s",
            (owners[1],),
        ),
        "removal_operation": (
            "SELECT to_jsonb(v) FROM personal_agent_cloud_removals v WHERE user_id=%s",
            (owners[1],),
        ),
        "private_review": (
            "SELECT to_jsonb(v) FROM one_action_directive_ledger v WHERE directive_id='synthetic-release-review'",
            None,
        ),
        "ciphertext": ("SELECT to_jsonb(v) FROM pkm_blobs v WHERE user_id=%s", (owners[0],)),
        "pending_cleanup": (
            "SELECT to_jsonb(v) FROM account_deletion_tombstones v WHERE firebase_uid=%s",
            (owners[2],),
        ),
        "pending_gmail_custody": (
            "SELECT to_jsonb(v) FROM kai_gmail_connections v WHERE user_id=%s",
            (owners[2],),
        ),
        "pending_consent_history": (
            "SELECT to_jsonb(v) FROM consent_audit v WHERE user_id=%s ORDER BY id",
            (owners[2],),
        ),
        "pending_referral_member": (
            "SELECT to_jsonb(v) FROM one_referral_network_members v WHERE user_id=%s",
            (owners[2],),
        ),
        "pending_notifications": (
            "SELECT to_jsonb(v) FROM user_push_tokens v WHERE user_id=%s",
            (owners[2],),
        ),
        "pending_email_choice": (
            "SELECT to_jsonb(v) FROM one_marketing_preferences v WHERE user_id=%s",
            (owners[2],),
        ),
    }
    before = {k: execute(*q) for k, q in queries.items()}
    payload = json.loads((cp / "db/release_migration_manifest.json").read_text())
    files = (
        payload["ordered_migrations"]
        + payload["environment_overlays"]["uat"]
        + [
            "418_account_provider_cleanup_staging.sql",
            "419_account_generations.sql",
            "420_private_agent_lifecycle_foundation.sql",
            "421_cloud_removal_recovery.sql",
        ]
    )
    files = sorted(set(files), key=lambda x: int(x[:3]))
    # Negative control: unchanged 020 reaches BEFORE INSERT even on conflict.
    import psycopg2
    import pytest

    with pytest.raises(psycopg2.errors.CheckViolation, match="account identity is deleted"):
        execute((cp / "db/migrations/020_ria_iam_foundation.sql").read_text())
    execute("ROLLBACK")
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="retains credential custody"):
        execute((cp / "db/migrations/046_kai_gmail_receipt_total.sql").read_text())
    execute("ROLLBACK")
    # The existing referral-policy adapter alone still hits the deleted-owner guard.
    from db.migration_authority import _replay_referral_policy_v4_sql

    referral = build_manifest_entries(
        cp / "db/migrations", ["347_one_referral_dashboard_lifecycle.sql"]
    )[0]
    with pytest.raises(psycopg2.errors.CheckViolation, match="account identity is deleted"):
        execute(_replay_referral_policy_v4_sql(referral))
    execute("ROLLBACK")
    for entry in build_manifest_entries(cp / "db/migrations", files):
        execute(_replay_sql(entry))
    after = {k: execute(*q) for k, q in queries.items()}
    assert before == after, "RETAINED_RECORD_BYTES_CHANGED: " + ",".join(
        k for k in before if before[k] != after[k]
    )
    assert (
        execute("SELECT cancel_personal_agent_cloud_removal(%s,%s)", (owners[1], attempt))[0][0]
        is True
    ), "SAME_REMOVAL_CANCEL_REFUSED_AFTER_REPLAY"
    assert execute("SELECT personal_agent_cloud_removal_ready()")[0][0] is True
    execute("CREATE TABLE synthetic_after_replay(user_id text)")
    assert (
        execute(
            "SELECT count(*) FROM pg_trigger WHERE tgrelid='synthetic_after_replay'::regclass AND tgname='account_retired_generation_update'"
        )[0][0]
        == 1
    ), "GENERATION_GUARD_LOST_AFTER_REPLAY"
    return before
