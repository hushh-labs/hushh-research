"""Authenticated Sandbox readiness proves the exact canonical release lane."""

import json

import pytest

from tests import scope_commerce_contract_fixtures as fixtures
from tests.scope_commerce_contract_harness import PaidContract

connector_postgres_url = fixtures.connector_postgres_url
paid_contract_dsn = fixtures.paid_contract_dsn
paid_contract = fixtures.paid_contract


async def test_sandbox_readiness_refuses_actor_origin_mode_and_unbound_pin(
    paid_contract: PaidContract,
    monkeypatch: pytest.MonkeyPatch,
):
    from dataclasses import replace

    from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy

    ctx = paid_contract
    original = ctx.service._config()
    policy = SandboxPolicy(original.platform_account_id, ("owner", "payer"))
    ctx.service.provider_config = replace(original, sandbox_policy=policy)
    origin = ctx.service._config().frontend_origin
    path = "/sandbox-readiness?app_origin=" + origin
    result = await ctx.get(path)
    assert result.status_code == 200, result.text
    proof = result.json()
    assert proof["persisted_pin_matches"] is True and proof["livemode"] is False
    assert proof["schema_head"] is None
    assert proof["new_activity_enabled"] is True
    from db.migration_authority import build_manifest_entries

    manifest = json.loads(
        (fixtures.MIGRATIONS.parent / "release_migration_manifest.json").read_text()
    )
    entries = build_manifest_entries(fixtures.MIGRATIONS, manifest["ordered_migrations"])
    async with ctx.pool.acquire() as c:
        await c.execute("""CREATE TABLE schema_migrations(
            migration_id TEXT PRIMARY KEY,filename TEXT,checksum_sha256 TEXT,
            status TEXT,baseline_through INTEGER)""")
        await c.executemany(
            "INSERT INTO schema_migrations VALUES($1,$2,$3,'applied',NULL)",
            [(e.migration_id, e.filename, e.checksum_sha256) for e in entries],
        )
        await c.execute(
            "INSERT INTO schema_migrations(migration_id,status) VALUES('957','applied')"
        )
    # The actual route must prove the release lane, never the larger parked tail.
    assert (await ctx.get(path)).json()["schema_head"] == max(e.numeric_version for e in entries)
    async with ctx.pool.acquire() as c:
        await c.execute(
            "DELETE FROM schema_migrations WHERE filename=$1", "292_consumer_scope_commerce.sql"
        )
    assert (await ctx.get(path)).json()["schema_head"] is None
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    paused = await ctx.get(path)
    assert paused.status_code == 200, paused.text
    assert paused.json()["persisted_pin_matches"] is True
    assert paused.json()["new_activity_enabled"] is False
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "true")
    ctx.service.provider_config = replace(ctx.service.provider_config, enabled=False)
    assert (await ctx.get(path)).json()["new_activity_enabled"] is False
    # Unknown costs can be inspected only while both admission switches are off.
    ctx.service.provider_config = replace(ctx.service.provider_config, countries={})
    assert (await ctx.get(path)).status_code == 503
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    unknown_costs = await ctx.get(path)
    assert unknown_costs.status_code == 200, unknown_costs.text
    assert unknown_costs.json()["new_activity_enabled"] is False
    ctx.service.provider_config = replace(ctx.service.provider_config, enabled=True)
    assert (await ctx.get(path)).status_code == 503
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "true")
    ctx.service.provider_config = replace(ctx.service.provider_config, countries=original.countries)
    assert not any(key in proof for key in ("reviewer_user_ids", "DSN", "secret_key"))
    assert (await ctx.get(path, "stranger")).status_code == 404
    assert (await ctx.get("/sandbox-readiness?app_origin=https://other.example")).status_code == 503
    ctx.service.provider_config = replace(ctx.service.provider_config, livemode=True)
    assert (await ctx.get(path)).status_code == 503
    ctx.service.provider_config = replace(ctx.service.provider_config, livemode=False)
    async with ctx.pool.acquire() as c:
        await c.execute("TRUNCATE scope_commerce_environment")
    assert (await ctx.get(path)).status_code == 503
    async with ctx.pool.acquire() as c:
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_environment") == 0
        await c.execute(
            "INSERT INTO scope_commerce_environment(singleton,platform_account_id,livemode) VALUES(true,'acct_other',false)"
        )
    assert (await ctx.get(path)).status_code == 503
