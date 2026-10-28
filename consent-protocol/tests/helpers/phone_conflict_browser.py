"""Disposable phone-browser SQL neighbours, fixtures and custody assertions."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

PHONE = "+16505550101"

OWNERS = {
    name: "synthetic" + name.replace("-", "") + "owner000000000001"
    for name in ("previous", "receiving-a", "wrong")
}

DEVICE = "tdv_syntheticphonefixture000001"

PRESERVATION_PROJECTIONS = {
    "vault_keys": "user_id,vault_status,vault_key_hash,primary_method,recovery_encrypted_vault_key,recovery_salt,recovery_iv",
    "pkm_data": "*",
    "shared_files_storage": "*",
}


async def _schema(pool):
    """Required neighbours plus actual phone/erasure migrations; no policy SQL copy."""
    async with pool.acquire() as conn:
        if await conn.fetchval(
            "SELECT to_regclass('public.account_phone_recovery_continuations') IS NOT NULL"
        ):
            return
        await conn.execute("""
          ALTER TABLE actor_profiles ADD COLUMN personas text[] DEFAULT ARRAY['investor'],
            ADD COLUMN last_active_persona text DEFAULT 'investor',
            ADD COLUMN investor_marketplace_opt_in boolean DEFAULT false,
            ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz;
          ALTER TABLE vault_keys ADD COLUMN vault_key_hash text, ADD COLUMN primary_wrapper_id text,
            ADD COLUMN recovery_encrypted_vault_key text, ADD COLUMN recovery_salt text,
            ADD COLUMN recovery_iv text, ADD COLUMN first_login_at bigint,
            ADD COLUMN last_login_at bigint, ADD COLUMN login_count bigint;
          CREATE TABLE personal_agent_registry(user_id text PRIMARY KEY,backend_metadata jsonb DEFAULT '{}');
          CREATE TABLE ria_client_invites(target_investor_user_id text,accepted_by_user_id text);
          CREATE TABLE user_push_tokens(user_id text);
          CREATE TABLE user_push_installations(user_id text);
          CREATE TABLE one_referral_policies(activated_at timestamptz,retired_at timestamptz);
          CREATE TABLE consent_audit(id bigserial,token_id text,user_id text,agent_id text,scope text,
            action text,issued_at bigint,expires_at bigint,metadata jsonb);
          ALTER TABLE internal_access_events ADD COLUMN expires_at bigint;
        """)
        for table in (
            "pkm_events",
            "pkm_scope_registry",
            "pkm_manifest_paths",
            "pkm_manifests",
            "pkm_blobs",
            "pkm_index",
        ):
            await conn.execute(f"CREATE TABLE {table}(user_id text)")
        for name in (
            "029_setup_state_rename.sql",
            "092_one_onboarding_journey_v1.sql",
            "094_one_onboarding_callback_attempt_v1.sql",
            "121_trusted_devices.sql",
            "130_one_runtime_setup_choice.sql",
            "176_trusted_device_sync_state.sql",
            "189_trusted_device_heartbeat.sql",
            "224_setup_capability_declined_ids.sql",
            "257_one_chat_onboarding_state.sql",
            "337_initial_contacts_onboarding.sql",
            "370_one_marketing_preferences.sql",
            "418_account_provider_cleanup_staging.sql",
            "423_account_shared_provider_authority.sql",
            "431_phone_recovery_actions.sql",
            "436_phone_linked_account_deletions.sql",
        ):
            await conn.execute((ROOT / "db/migrations" / name).read_text())


async def _seed(pool, *, files: bool):
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE account_phone_linked_deletions,account_deletion_tombstones,account_generations,actor_profiles,vault_keys,pkm_data,shared_files_storage,account_phone_transfers,account_phone_auth_fences,account_firebase_mutations,internal_access_events,trusted_devices,trusted_device_audit_events CASCADE"
        )
        for uid in OWNERS.values():
            await conn.execute("INSERT INTO actor_profiles(user_id) VALUES($1)", uid)
            await conn.execute(
                "INSERT INTO vault_keys(user_id,vault_status,vault_key_hash,setup_completed) VALUES($1,$2,$3,$4)",
                uid,
                "placeholder" if uid == OWNERS["receiving-a"] else "active",
                None if uid == OWNERS["receiving-a"] else "synthetic-commitment",
                uid != OWNERS["receiving-a"],
            )
            if uid != OWNERS["receiving-a"]:
                await conn.execute(
                    "INSERT INTO pkm_data(user_id,encrypted_data_ciphertext) VALUES($1,'preserved-synthetic-ciphertext')",
                    uid,
                )
            await conn.execute(
                "INSERT INTO actor_identity_cache(user_id,phone_number,phone_verified,email_verified,last_synced_at) VALUES($1,$2,$3,TRUE,clock_timestamp())",
                uid,
                PHONE if uid == OWNERS["previous"] else None,
                uid == OWNERS["previous"],
            )
        if files:
            await conn.execute(
                "INSERT INTO shared_files_storage(user_id,bucket,prefix) VALUES($1,'synthetic-ciphertext-bucket','opaque-library-prefix')",
                OWNERS["previous"],
            )
        await conn.execute(
            "INSERT INTO trusted_devices(device_id,user_id,device_public_key,device_name,platform,created_at) VALUES($1,$2,'synthetic-public-key','Fixture computer','macos',1)",
            DEVICE,
            OWNERS["previous"],
        )
        return {
            table: await conn.fetch(f"SELECT {projection} FROM {table} ORDER BY user_id")
            for table, projection in PRESERVATION_PROJECTIONS.items()
        }


async def _assert_erased(conn, recorded, baseline):
    for table in ("actor_profiles", "vault_keys", "pkm_data", "actor_identity_cache"):
        assert (
            await conn.fetchval(
                f"SELECT count(*) FROM {table} WHERE user_id=$1", OWNERS["previous"]
            )
            == 0
        )
    assert await conn.fetchval("SELECT count(*) FROM actor_profiles") == 2
    for table, before in baseline.items():
        assert await conn.fetch(
            f"SELECT {PRESERVATION_PROJECTIONS[table]} FROM {table} ORDER BY user_id"
        ) == [row for row in before if row["user_id"] != OWNERS["previous"]]
    assert await conn.fetchval("SELECT erasure_phase FROM account_deletion_tombstones") == "erased"
    assert (
        await conn.fetchval("SELECT cleanup_last_outcome FROM account_deletion_tombstones")
        == "identity_retained"
    )
    assert (
        await conn.fetchval(
            "SELECT count(*) FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
            PHONE,
        )
        == 0
    )
    assert await conn.fetchval("SELECT count(*) FROM account_phone_recovery_continuations") == 0
    assert recorded.unlink_count == 0


async def _assert_linked_deleted(conn, recorded, baseline):
    """Phone proof deleted the holder; the worker erased it; the requester owns the number."""
    for table in ("actor_profiles", "vault_keys", "pkm_data", "actor_identity_cache"):
        assert (
            await conn.fetchval(
                f"SELECT count(*) FROM {table} WHERE user_id=$1", OWNERS["previous"]
            )
            == 0
        )
    for table, before in baseline.items():
        assert await conn.fetch(
            f"SELECT {PRESERVATION_PROJECTIONS[table]} FROM {table} ORDER BY user_id"
        ) == [row for row in before if row["user_id"] != OWNERS["previous"]]
    assert await conn.fetchval("SELECT erasure_phase FROM account_deletion_tombstones") == "erased"
    owner = await conn.fetchval(
        "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
        PHONE,
    )
    assert owner == OWNERS["receiving-a"]
    receipts = await conn.fetch(
        "SELECT state,target_user_id,proof_event_digest IS NOT NULL AS proven "
        "FROM account_phone_linked_deletions WHERE state<>'cancelled'"
    )
    # Final erasure detached the holder id; the admitted receipt survives.
    assert [dict(row) for row in receipts] == [
        {"state": "admitted", "target_user_id": None, "proven": True}
    ]
    assert await conn.fetchval("SELECT count(*) FROM account_phone_recovery_continuations") == 0
    assert recorded.unlink_count == 0


async def _assert_preserved(conn, recorded, baseline, scenario):
    assert await conn.fetchval("SELECT count(*) FROM actor_profiles") == 3
    for table, before in baseline.items():
        assert (
            await conn.fetch(
                f"SELECT {PRESERVATION_PROJECTIONS[table]} FROM {table} ORDER BY user_id"
            )
            == before
        )
    assert await conn.fetchval("SELECT count(*) FROM account_deletion_tombstones") == 0
    owner = await conn.fetchval(
        "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
        PHONE,
    )
    assert owner == OWNERS["receiving-a" if scenario == "transfer" else "previous"]
    assert recorded.unlink_count == int(scenario == "transfer")
    if scenario == "recover":
        rows = await conn.fetch(
            "SELECT requester_user_id,target_user_id,action FROM account_phone_recovery_continuations"
        )
        assert [dict(row) for row in rows] == [
            {
                "requester_user_id": OWNERS["receiving-a"],
                "target_user_id": OWNERS["previous"],
                "action": "recover",
            }
        ]
    if scenario == "transfer":
        assert await conn.fetchval("SELECT count(*) FROM account_firebase_mutations") == 1
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM internal_access_events WHERE action='REVOKED'"
            )
            == 1
        )
    if scenario == "devices":
        assert (
            await conn.fetchval("SELECT status FROM trusted_devices WHERE device_id=$1", DEVICE)
            == "revoked"
        )
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM account_device_actions WHERE state='completed'"
            )
            == 1
        )
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM trusted_device_audit_events WHERE event_type='device_revoked'"
            )
            == 1
        )
        assert recorded.sends == 2
