"""The model a turn runs on is resolved at call time, with the person above the lane.

The regression these guard is a real one: the fleet model was a module-level constant
read from ``HUSSH_GEMINI_TEXT_MODEL`` at import, consumed by a process-wide singleton, so
changing it meant a redeploy and every person on a lane shared one answer.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_firebase_auth_read_only
from api.routes.one import models as model_routes
from hushh_mcp import constants
from hushh_mcp.runtime_providers import model_catalog
from hushh_mcp.services import model_preference_service as prefs
from hushh_mcp.services import private_text_processing_approval_service as approval


def test_catalog_comes_from_the_registry_not_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HUSSH_GEMINI_TEXT_MODEL", raising=False)
    choices = model_catalog.selectable_text_models()
    assert [choice.model_id for choice in choices] == [
        "gemini-3.8-flash",
    ], "one registry-backed Flash release and no choice (owner decision 2026-10-15)"
    assert all(choice.label.startswith("Gemini ") for choice in choices)
    assert model_catalog.is_selectable_text_model("gemini-3.8-flash")
    # A stored 3.7 choice is no longer selectable, so it resolves to the lane default.
    assert not model_catalog.is_selectable_text_model("gemini-3.7-flash")
    assert not model_catalog.is_selectable_text_model("gemini-3.6-flash")
    assert not model_catalog.is_selectable_text_model("gemini-3.1-pro-preview")
    assert not model_catalog.is_selectable_text_model("not-a-model")
    assert not model_catalog.is_selectable_text_model("")


def test_lane_default_is_read_at_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """No copy is frozen into the catalog module when it is first imported."""
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")
    assert model_catalog.deployment_default_text_model() == "gemini-3.7-flash"
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.8-flash")
    assert model_catalog.deployment_default_text_model() == "gemini-3.8-flash"
    assert any(
        choice.is_default and choice.model_id == "gemini-3.8-flash"
        for choice in model_catalog.selectable_text_models()
    )


@pytest.mark.asyncio
async def test_person_choice_outranks_the_lane(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")

    async def _stored(user_id: str) -> str | None:
        return "gemini-3.8-flash" if user_id == "chooser" else None

    monkeypatch.setattr(prefs, "_stored_choice", _stored)

    chosen = await prefs.resolve_text_model("chooser")
    assert (chosen.model_id, chosen.source) == ("gemini-3.8-flash", prefs.SOURCE_USER)

    followed = await prefs.resolve_text_model("someone-else")
    assert (followed.model_id, followed.source) == ("gemini-3.7-flash", prefs.SOURCE_DEPLOYMENT)

    anonymous = await prefs.resolve_text_model(None)
    assert anonymous.model_id == "gemini-3.7-flash"
    assert anonymous.selected is None


@pytest.mark.asyncio
@pytest.mark.parametrize("withdrawn_model", ["gemini-2.0-retired", "gemini-3.6-flash"])
async def test_a_withdrawn_choice_degrades_instead_of_failing_the_turn(
    monkeypatch: pytest.MonkeyPatch,
    withdrawn_model: str,
) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.8-flash")

    async def _stored(user_id: str) -> str | None:
        return withdrawn_model

    monkeypatch.setattr(prefs, "_stored_choice", _stored)
    resolved = await prefs.resolve_text_model("chooser")
    assert resolved.model_id == "gemini-3.8-flash", "a stale choice never reaches the provider"
    assert resolved.source == prefs.SOURCE_DEPLOYMENT
    assert resolved.selected == withdrawn_model, "the stale choice stays visible"


@pytest.mark.asyncio
async def test_an_empty_lane_falls_back_to_the_proven_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "")

    async def _stored(user_id: str) -> str | None:
        return None

    monkeypatch.setattr(prefs, "_stored_choice", _stored)
    resolved = await prefs.resolve_text_model("someone")
    assert resolved.model_id == constants.FLEET_TEXT_MODEL_DEFAULT
    assert resolved.source == prefs.SOURCE_FALLBACK


@pytest.mark.asyncio
async def test_a_preference_read_failure_never_breaks_a_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The store is unreachable; the agent still answers on the lane default."""
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")

    async def _boom() -> None:
        raise RuntimeError("pool down")

    monkeypatch.setattr(prefs, "get_pool", _boom)
    assert await prefs.resolve_text_model_name("someone") == "gemini-3.7-flash"


@pytest.mark.asyncio
async def test_a_busy_preference_store_does_not_block_catalog_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The header can show the served catalog while the preference pool is busy."""
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.7-flash")

    async def _slow(_user_id: str) -> None:
        await asyncio.sleep(prefs._STORED_CHOICE_READ_TIMEOUT_SECONDS + 0.05)
        return None

    monkeypatch.setattr(prefs, "_stored_choice", _slow)
    resolved = await prefs.resolve_text_model("someone")
    assert (resolved.model_id, resolved.source, resolved.selected) == (
        "gemini-3.7-flash",
        prefs.SOURCE_DEPLOYMENT,
        None,
    )


@pytest.mark.asyncio
async def test_an_unavailable_model_is_refused_with_the_list_that_is(monkeypatch) -> None:
    async def unused_pool():
        return None

    monkeypatch.setattr(prefs, "get_pool", unused_pool)
    with pytest.raises(prefs.ModelPreferenceError) as caught:
        await prefs.set_preference(user_id="someone", model_id="gemini-3.1-pro-preview")
    assert caught.value.code == "MODEL_NOT_SELECTABLE"
    assert "gemini-3.8-flash" in str(caught.value)

    with pytest.raises(prefs.ModelPreferenceError) as missing_user:
        await prefs.set_preference(user_id="  ", model_id="gemini-3.8-flash")
    assert missing_user.value.code == "USER_REQUIRED"


def _approved_row():
    return {
        "enabled": True,
        "disclosure_version": approval.PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
        "generation": uuid.uuid4(),
        "accepted_at": datetime.now(UTC),
        "revoked_at": None,
    }


@pytest.mark.asyncio
async def test_uat_drive_default_has_policy_authority_not_fake_owner_acceptance(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")

    async def missing(_owner):
        return None

    monkeypatch.setattr(approval, "_read", missing)
    for owner in ("existing-account", "new-account"):
        status = await approval.get_private_text_approval(user_id=owner, include_policy=True)
        assert status["enabled"] is False
        assert status["accepted_at"] is None and status["generation"] is None
        assert status["processing_policy"]["enabled"] is True
        assert status["processing_policy"]["basis"] == "uat_policy"
        grant = await approval.require_private_azure_text_approval(
            owner, scope=approval.DRIVE_DOCUMENT_REQUESTS_SCOPE
        )
        assert grant.user_id == owner and grant.authorization_basis == "uat_policy"
        await approval.private_azure_text_require_current(grant)()
        # The same absent receipt grants no generic private chat permission.
        with pytest.raises(approval.PrivateTextApprovalError):
            await approval.require_private_azure_text_approval(owner)
        # Old strict clients receive the unchanged owner-receipt shape.
        assert "processing_policy" not in await approval.get_private_text_approval(user_id=owner)


@pytest.mark.asyncio
async def test_uat_drive_policy_rechecks_revocation_generation_and_environment(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")
    row = None

    async def read(_owner):
        return row

    monkeypatch.setattr(approval, "_read", read)
    grant = await approval.require_private_azure_text_approval(
        "owner", scope=approval.DRIVE_DOCUMENT_REQUESTS_SCOPE
    )
    current = approval.private_azure_text_require_current(grant)
    await current()
    row = {**_approved_row(), "enabled": False, "revoked_at": datetime.now(UTC)}
    await current()  # A historical pilot refusal is not this administrator policy.
    row = None
    from hushh_mcp import managed_ai_config

    original = managed_ai_config.load_private_drive_text_policy()
    monkeypatch.setattr(
        __import__(
            "hushh_mcp.runtime_providers.managed_text", fromlist=["load_private_drive_text_policy"]
        ),
        "load_private_drive_text_policy",
        lambda: {**original, "version": "rotated-policy-v2"},
    )
    with pytest.raises(approval.PrivateTextApprovalError) as changed:
        await current()
    assert changed.value.code == "PRIVATE_AZURE_TEXT_APPROVAL_CHANGED"
    monkeypatch.setattr(
        __import__(
            "hushh_mcp.runtime_providers.managed_text", fromlist=["load_private_drive_text_policy"]
        ),
        "load_private_drive_text_policy",
        lambda: original,
    )
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "gemini")
    await current()  # Old selector cannot silently choose Gemini.
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")
    for environment in ("production", "development", ""):
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", environment)
        if not environment:
            monkeypatch.setenv("ENVIRONMENT", "")
        with pytest.raises(approval.PrivateTextApprovalError):
            await current()


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["disabled", "old-version", "no-receipt", "revoked"])
async def test_uat_admin_policy_does_not_rewrite_a_legacy_pilot_receipt(monkeypatch, state):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")
    row = _approved_row()
    if state == "disabled":
        row["enabled"] = False
    elif state == "old-version":
        row["disclosure_version"] = "old-version"
    elif state == "no-receipt":
        row["accepted_at"] = None
    else:
        row["revoked_at"] = datetime.now(UTC)

    async def read(_owner):
        return row

    monkeypatch.setattr(approval, "_read", read)
    before = dict(row)
    for scope in (approval.DRIVE_DOCUMENT_REQUESTS_SCOPE, "one_text_chat"):
        grant = await approval.require_private_azure_text_approval("owner", scope=scope)
        assert grant.authorization_basis == "uat_policy"
    assert row == before
    with pytest.raises(approval.PrivateTextApprovalError):
        await approval.require_private_azure_text_approval("owner")


@pytest.mark.asyncio
async def test_private_azure_approval_is_owner_bound_and_rechecked_before_each_send(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    row = _approved_row()

    async def read(owner):
        return row if owner == "owner-a" else None

    monkeypatch.setattr(approval, "_read", read)
    grant = await approval.require_private_azure_text_approval("owner-a")
    require_current = approval.private_azure_text_require_current(grant)
    sent = []

    async def send():
        await require_current()
        sent.append("synthetic")

    await send()  # positive control: current approval permits the boundary
    assert sent == ["synthetic"]
    with pytest.raises(approval.PrivateTextApprovalError, match="current approval"):
        await approval.require_private_azure_text_approval("owner-b")
    row["enabled"] = False
    with pytest.raises(approval.PrivateTextApprovalError):
        await send()  # a retry cannot reuse the earlier successful check
    row["enabled"] = True
    row["generation"] = uuid.uuid4()
    with pytest.raises(approval.PrivateTextApprovalError) as changed:
        await send()  # reapproval cannot revive work from the old generation
    assert changed.value.code == "PRIVATE_AZURE_TEXT_APPROVAL_CHANGED"
    assert sent == ["synthetic"]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["missing", "legacy-version", "no-receipt"])
async def test_model_selection_and_legacy_receipts_cannot_grant_private_azure(monkeypatch, state):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    row = _approved_row()
    if state == "legacy-version":
        row["disclosure_version"] = "pwm-azure-bing-v1"
    elif state == "no-receipt":
        row["accepted_at"] = None

    async def read(_owner):
        return None if state == "missing" else row

    monkeypatch.setattr(approval, "_read", read)
    monkeypatch.setattr(constants, "GEMINI_MODEL", "azure-choice-is-not-approval")
    assert (await approval.get_private_text_approval(user_id="owner"))["enabled"] is False
    with pytest.raises(approval.PrivateTextApprovalError):
        await approval.require_private_azure_text_approval("owner")


@pytest.mark.asyncio
async def test_private_approval_store_failure_denies_and_cancellation_propagates(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)

    async def broken_pool():
        raise RuntimeError("sensitive provider diagnostic must not escape")

    monkeypatch.setattr(approval, "get_pool", broken_pool)
    for operation in (
        approval.get_private_text_approval(user_id="owner"),
        approval.require_private_azure_text_approval("owner"),
        approval.set_private_text_approval(
            user_id="owner",
            enabled=True,
            expected_generation=None,
            disclosure_version=approval.PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
        ),
    ):
        with pytest.raises(approval.PrivateTextApprovalError) as unavailable:
            await operation
        assert unavailable.value.status_code == 503
        assert "sensitive" not in str(unavailable.value)

    async def cancelled_pool():
        raise asyncio.CancelledError()

    monkeypatch.setattr(approval, "get_pool", cancelled_pool)
    with pytest.raises(asyncio.CancelledError):
        await approval.require_private_azure_text_approval("owner")


def test_private_approval_route_uses_authenticated_owner_and_rejects_body_owner(monkeypatch):
    calls = []

    async def write(**kwargs):
        calls.append(kwargs)
        return {"enabled": kwargs["enabled"]}

    monkeypatch.setattr(approval, "set_private_text_approval", write)
    app = FastAPI()
    app.include_router(model_routes.router)
    client = TestClient(app)
    path = "/api/one/models/private-text-approval"
    assert client.get(path).status_code == 401
    assert client.put(path, json={"enabled": False}).status_code == 401
    app.dependency_overrides[require_firebase_auth] = lambda: "authenticated-owner"
    assert client.put(path, json={"enabled": False, "expected_generation": None}).status_code == 200
    assert calls == [
        {
            "user_id": "authenticated-owner",
            "enabled": False,
            "expected_generation": None,
            "disclosure_version": None,
        }
    ]
    for invalid in (
        {"enabled": True, "user_id": "another-owner"},
        {"enabled": "true"},
        {"enabled": True, "generation": str(uuid.uuid4())},
        {"enabled": False},
        {"enabled": False, "expected_generation": "not-a-generation"},
    ):
        assert client.put(path, json=invalid).status_code == 422
    assert len(calls) == 1

    async def stale_write(**_kwargs):
        raise approval.PrivateTextApprovalError(
            "Read the changed approval.",
            code="PRIVATE_AZURE_TEXT_APPROVAL_CHANGED",
            status_code=409,
        )

    monkeypatch.setattr(approval, "set_private_text_approval", stale_write)
    stale = client.put(path, json={"enabled": False, "expected_generation": str(uuid.uuid4())})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "PRIVATE_AZURE_TEXT_APPROVAL_CHANGED"


def test_private_approval_is_uat_only_and_requires_current_explicit_disclosure(monkeypatch):
    async def untouched_pool():
        pytest.fail("no storage access before environment/disclosure checks")

    monkeypatch.setattr(approval, "get_pool", untouched_pool)
    app = FastAPI()
    app.include_router(model_routes.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "owner"
    client = TestClient(app)
    path = "/api/one/models/private-text-approval"
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    assert client.get(path).status_code == 403
    assert client.put(path, json={"enabled": False, "expected_generation": None}).status_code == 403
    monkeypatch.delenv("HUSHH_DEPLOY_ENV")
    for version in (None, "pwm-azure-bing-v1", "privacy-2.6"):
        response = client.put(
            path,
            json={
                "enabled": True,
                "expected_generation": None,
                "disclosure_version": version,
            },
        )
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "PRIVATE_AZURE_TEXT_DISCLOSURE_MISMATCH"


@pytest.mark.asyncio
async def test_private_approval_postgres_replay_revoke_and_generation_fence(monkeypatch):
    """Real SQL protects durable approval; isolated schema leaves other suites alone."""
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    import asyncpg

    root = Path(__file__).resolve().parents[1] / "db"
    name = "364_one_private_text_processing_approvals"
    migration = (root / "migrations" / f"{name}.sql").read_text()
    rollback = (root / "migrations/rollback" / f"{name}.rollback.sql").read_text()
    schema = f"private_approval_{uuid.uuid4().hex}"
    url = url.replace("postgresql+psycopg2://", "postgresql://", 1)
    connection = await asyncpg.connect(url)
    await connection.execute(f'CREATE SCHEMA "{schema}"')
    pool = await asyncpg.create_pool(
        url, min_size=1, max_size=2, server_settings={"search_path": schema}
    )

    async def get_pool():
        return pool

    monkeypatch.setattr(approval, "get_pool", get_pool)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    try:
        await pool.execute("CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)")
        await pool.execute("INSERT INTO actor_profiles VALUES ('owner-a'), ('owner-b')")
        await pool.execute(migration)
        await pool.execute(migration)
        monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")
        default = await approval.get_private_text_approval(user_id="owner-b", include_policy=True)
        assert default["processing_policy"]["enabled"] is True
        assert default["generation"] is None and default["accepted_at"] is None
        policy_grant = await approval.require_private_azure_text_approval(
            "owner-b", scope=approval.DRIVE_DOCUMENT_REQUESTS_SCOPE
        )
        opted_out = await approval.set_private_text_approval(
            user_id="owner-b", enabled=False, expected_generation=None, include_policy=True
        )
        assert opted_out["accepted_at"] is None
        assert opted_out["processing_policy"]["enabled"] is True
        assert opted_out["generation"] != policy_grant.generation
        await approval.private_azure_text_require_current(policy_grant)()
        await pool.execute("DELETE FROM actor_profiles WHERE user_id = 'owner-b'")
        assert (await approval.get_private_text_approval(user_id="owner-a"))["enabled"] is False
        first = await approval.set_private_text_approval(
            user_id="owner-a",
            enabled=True,
            expected_generation=None,
            disclosure_version=approval.PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
        )
        same = await approval.set_private_text_approval(
            user_id="owner-a",
            enabled=True,
            expected_generation=first["generation"],
            disclosure_version=approval.PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
        )
        assert same == first  # an unchanged choice with current CAS preserves the grant
        assert (await approval.get_private_text_approval(user_id="owner-b"))["enabled"] is False
        grant = await approval.require_private_azure_text_approval("owner-a")
        revoked = await approval.set_private_text_approval(
            user_id="owner-a",
            enabled=False,
            expected_generation=first["generation"],
        )
        assert revoked["generation"] != first["generation"]
        assert revoked["accepted_at"] == first["accepted_at"]
        assert revoked["revoked_at"] is not None
        for stale_generation in (None, first["generation"]):
            with pytest.raises(approval.PrivateTextApprovalError) as stale:
                await approval.set_private_text_approval(
                    user_id="owner-a",
                    enabled=True,
                    expected_generation=stale_generation,
                    disclosure_version=approval.PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
                )
            assert stale.value.status_code == 409
            assert (await approval.get_private_text_approval(user_id="owner-a")) == revoked
        with pytest.raises(approval.PrivateTextApprovalError):
            await approval.private_azure_text_require_current(grant)()
        fresh = await approval.set_private_text_approval(
            user_id="owner-a",
            enabled=True,
            expected_generation=revoked["generation"],
            disclosure_version=approval.PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
        )
        assert fresh["enabled"] is True
        assert fresh["generation"] not in (first["generation"], revoked["generation"])
        with pytest.raises(approval.PrivateTextApprovalError):
            await approval.private_azure_text_require_current(grant)()
        async with pool.acquire() as conn:
            with pytest.raises(asyncpg.RaiseError, match="rollback_refused_nonempty_table"):
                await conn.execute(rollback)
            # The deliberate rollback refusal leaves this transaction aborted.
            await conn.execute("ROLLBACK")
        await pool.execute("DELETE FROM actor_profiles WHERE user_id = 'owner-a'")
        assert (
            await pool.fetchval("SELECT COUNT(*) FROM one_private_text_processing_approvals") == 0
        )
        await pool.execute(rollback)
    finally:
        await pool.close()
        await connection.execute(f'DROP SCHEMA "{schema}" CASCADE')
        await connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,label", [("azure_openai", "Azure"), ("vertex", "Vertex")])
async def test_uat_effective_model_is_managed_for_saved_and_missing_choices(
    monkeypatch, provider, label
):
    from hushh_mcp.runtime_providers.managed_text import managed_text_binding

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", provider)
    for selected in (None, "gemini-3.7-flash"):

        async def stored(_owner, choice=selected):
            return choice

        monkeypatch.setattr(prefs, "_stored_choice", stored)
        payload = await prefs.get_preference(user_id="arbitrary-owner")
        assert payload["effective_model"] == managed_text_binding()["deployment"]
        assert payload["source"] == "administrator_policy"
        assert payload["selected_model"] == selected
        assert len(payload["choices"]) == 1
        assert payload["choices"][0]["label"] == f"{label} · managed in UAT"
        with pytest.raises(prefs.ModelPreferenceError) as denied:
            await prefs.set_preference(user_id="arbitrary-owner", model_id=selected)
        assert denied.value.code == "MODEL_MANAGED_BY_POLICY"
