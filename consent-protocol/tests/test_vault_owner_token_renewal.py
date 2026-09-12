"""Renewal keeps the canonical ledger authoritative, including expired lineage."""

import json
import threading
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from db.db_client import DatabaseClient
from hushh_mcp.consent.token import issue_token, validate_owner_renewal_proof, validate_token
from hushh_mcp.services.consent_db import ConsentDBService, VaultOwnerRenewalRejected


@pytest.fixture
def owner_proof():
    def create(user_id="renewal-owner", agent_id="self", scope="vault.owner", ttl=-1000):
        return issue_token(user_id, agent_id, scope, expires_in_ms=ttl)

    return create


@pytest.fixture
def ledger(monkeypatch):
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )
    with engine.begin() as connection:
        connection.execute(
            text("""CREATE TABLE internal_access_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT, user_id TEXT,
            agent_id TEXT, scope TEXT, action TEXT, issued_at BIGINT, expires_at BIGINT,
            scope_description TEXT, metadata TEXT, request_id TEXT)""")
        )
    service = ConsentDBService()
    thread_ids = []

    def db():
        thread_ids.append(threading.get_ident())
        return DatabaseClient(engine=engine)

    monkeypatch.setattr(service, "_get_db", db)

    def grant(token):
        with engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO internal_access_events
                (token_id, user_id, agent_id, scope, action, issued_at, expires_at)
                VALUES (:token, :user_id, :agent_id, :scope, 'CONSENT_GRANTED',
                        :issued_at, :expires_at)"""),
                {
                    "token": token.token,
                    "user_id": str(token.user_id),
                    "agent_id": str(token.agent_id),
                    "scope": token.scope_str,
                    "issued_at": token.issued_at,
                    "expires_at": token.expires_at,
                },
            )

    yield service, engine, grant, thread_ids
    engine.dispose()


async def test_expired_owner_evidence_renews_but_never_authorizes_data(ledger, owner_proof):
    service, _, grant, thread_ids = ledger
    prior = owner_proof()
    grant(prior)
    assert validate_token(prior.token)[0] is False
    assert validate_owner_renewal_proof(prior.token, str(prior.user_id))[0] is True
    renewed = await service.renew_vault_owner_token(str(prior.user_id), prior.token)
    assert validate_token(renewed["token"])[0] is True
    assert thread_ids and threading.get_ident() not in thread_ids
    # Concurrent/duplicate callers may reuse the current descendant, not mint endlessly.
    assert await service.renew_vault_owner_token(str(prior.user_id), prior.token) == renewed


@pytest.mark.parametrize(
    "user_id,agent_id,scope",
    [
        ("another-owner", "self", "vault.owner"),
        ("renewal-owner", "device:synthetic-device", "vault.owner"),
        ("renewal-owner", "self", "pkm.read"),
    ],
)
async def test_wrong_user_device_or_scoped_proof_cannot_upgrade(
    ledger, owner_proof, user_id, agent_id, scope
):
    service, _, grant, _ = ledger
    prior = owner_proof(user_id, agent_id, scope)
    grant(prior)
    with pytest.raises(VaultOwnerRenewalRejected):
        await service.renew_vault_owner_token("renewal-owner", prior.token)


async def test_revocation_permanently_breaks_old_lineage_even_after_new_unlock(ledger, owner_proof):
    service, _, grant, _ = ledger
    prior = owner_proof()
    grant(prior)
    await service.insert_internal_event("renewal-owner", "self", "vault.owner", "REVOKED")
    grant(owner_proof(ttl=86400000))  # A distinct explicit unlock cannot revive old evidence.
    with pytest.raises(VaultOwnerRenewalRejected):
        await service.renew_vault_owner_token("renewal-owner", prior.token)


async def test_missing_grant_fails_closed(ledger, owner_proof):
    service, _, _, _ = ledger
    with pytest.raises(VaultOwnerRenewalRejected):
        await service.renew_vault_owner_token("renewal-owner", owner_proof().token)


async def test_overlapping_owner_tokens_keep_original_expiry_and_share_revocation(
    ledger, owner_proof
):
    service, engine, grant, _ = ledger
    prior = owner_proof(ttl=60000)
    grant(prior)
    renewed = await service.renew_vault_owner_token("renewal-owner", prior.token)
    assert renewed["token"] != prior.token
    for token in (prior.token, renewed["token"]):
        assert await service.is_token_active("renewal-owner", "vault.owner", "self", token_id=token)
        assert not await service.is_token_active(
            "other-owner", "vault.owner", "self", token_id=token
        )
    # Clock ties/backwards timestamps do not defeat the ledger ID ordering.
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO internal_access_events
            (token_id, user_id, agent_id, scope, action, issued_at)
            VALUES ('synthetic-revocation', 'renewal-owner', 'self', 'vault.owner', 'REVOKED', 1)""")
        )
    for token in (prior.token, renewed["token"]):
        assert not await service.is_token_active(
            "renewal-owner", "vault.owner", "self", token_id=token
        )
        with pytest.raises(VaultOwnerRenewalRejected):
            await service.renew_vault_owner_token("renewal-owner", token)


async def test_overlap_never_extends_original_expiry(ledger, owner_proof):
    service, _, grant, _ = ledger
    prior = owner_proof()
    grant(prior)
    await service.renew_vault_owner_token("renewal-owner", prior.token)
    assert not await service.is_token_active(
        "renewal-owner", "vault.owner", "self", token_id=prior.token
    )


async def test_identical_token_reinserted_after_revocation_cannot_reactivate(ledger, owner_proof):
    service, _, grant, _ = ledger
    prior = owner_proof(ttl=60000)
    grant(prior)
    await service.insert_internal_event("renewal-owner", "self", "vault.owner", "REVOKED")
    grant(prior)  # Deterministic same-millisecond issuance must not revive this token.
    assert not await service.is_token_active(
        "renewal-owner", "vault.owner", "self", token_id=prior.token
    )
    with pytest.raises(VaultOwnerRenewalRejected):
        await service.renew_vault_owner_token("renewal-owner", prior.token)
    distinct = owner_proof(ttl=120000)
    grant(distinct)
    assert await service.is_token_active(
        "renewal-owner", "vault.owner", "self", token_id=distinct.token
    )


async def test_device_tokens_keep_latest_only_policy(ledger, owner_proof):
    service, _, grant, _ = ledger
    prior = owner_proof(agent_id="device:test", ttl=60000)
    latest = owner_proof(agent_id="device:test", ttl=120000)
    grant(prior)
    grant(latest)
    with service._get_db().engine.begin() as connection:
        connection.execute(text("UPDATE internal_access_events SET issued_at = issued_at + id"))
    assert not await service.is_token_active(
        "renewal-owner", "vault.owner", "device:test", token_id=prior.token
    )
    assert await service.is_token_active(
        "renewal-owner", "vault.owner", "device:test", token_id=latest.token
    )


async def test_renewal_and_revocation_use_same_transaction_lock(ledger, owner_proof, monkeypatch):
    from hushh_mcp.services import consent_db

    service, _, grant, _ = ledger
    prior = owner_proof()
    grant(prior)
    locks = []

    def lock(connection, user_id):
        assert connection.in_transaction()
        locks.append(user_id)

    monkeypatch.setattr(consent_db, "_lock_owner_lineage", lock)
    await service.renew_vault_owner_token("renewal-owner", prior.token)
    await service.insert_internal_event("renewal-owner", "self", "vault.owner", "REVOKED")
    assert locks == ["renewal-owner", "renewal-owner"]


async def test_tampered_proof_never_reaches_ledger(ledger, owner_proof):
    service, _, _, threads = ledger
    with pytest.raises(VaultOwnerRenewalRejected):
        await service.renew_vault_owner_token("renewal-owner", owner_proof().token + "tampered")
    assert threads == []


def request(body):
    async def receive():
        return {"type": "http.request", "body": json.dumps(body).encode()}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [(b"authorization", b"Bearer synthetic-firebase")],
        },
        receive,
    )


async def test_route_renewal_db_outage_never_falls_back_to_initial_issuance(
    monkeypatch, owner_proof
):
    from api.routes import consent

    initial = AsyncMock()
    monkeypatch.setattr(consent, "verify_firebase_bearer", lambda _: "renewal-owner")
    monkeypatch.setattr(consent, "_issue_or_reuse_vault_owner_token", initial)
    monkeypatch.setattr(
        consent.ConsentDBService,
        "renew_vault_owner_token",
        AsyncMock(side_effect=RuntimeError("unavailable")),
    )
    with pytest.raises(HTTPException) as failure:
        await consent.issue_vault_owner_token(
            request({"userId": "renewal-owner", "renewalOfToken": owner_proof().token})
        )
    assert failure.value.status_code == 503
    assert failure.value.detail["code"] == "AUTH_ACCOUNT_STATUS_UNAVAILABLE"
    initial.assert_not_called()


async def test_route_explicit_unlock_keeps_existing_bootstrap_contract(monkeypatch):
    from api.routes import consent

    initial = AsyncMock(return_value={"token": "synthetic-result"})
    monkeypatch.setattr(consent, "verify_firebase_bearer", lambda _: "renewal-owner")
    monkeypatch.setattr(consent, "_issue_or_reuse_vault_owner_token", initial)
    assert await consent.issue_vault_owner_token(request({"userId": "renewal-owner"})) == {
        "token": "synthetic-result"
    }
    initial.assert_awaited_once_with(user_id="renewal-owner")


async def test_route_acknowledges_only_validated_renewal(monkeypatch, owner_proof):
    from api.routes import consent

    prior = owner_proof()
    renew = AsyncMock(return_value={"token": "synthetic-renewed"})
    monkeypatch.setattr(consent, "verify_firebase_bearer", lambda _: "renewal-owner")
    monkeypatch.setattr(consent.ConsentDBService, "renew_vault_owner_token", renew)
    result = await consent.issue_vault_owner_token(
        request(
            {
                "userId": "renewal-owner",
                "renewalOfToken": prior.token,
            }
        )
    )
    assert result["renewalValidated"] is True
    renew.assert_awaited_once_with("renewal-owner", prior.token)
