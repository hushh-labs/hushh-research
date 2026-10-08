"""Transactional marketplace consent delivery and revocation boundaries."""

from __future__ import annotations

import asyncio
import copy
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService

_SAMPLE_JWK = {"kty": "EC", "crv": "P-256", "x": "public_x", "y": "public_y"}
_REQUEST_ID = "dc34872c-33a5-4ad6-95a2-e604d603d793"
_ENVELOPE_ID = UUID("1dcdca55-07ec-465f-9d36-9ceea19c14f1")
_SCOPE = "attr.personal_data.insurance.*"


class _Connection:
    def __init__(self, *, status="approved"):
        self.request = {
            "id": UUID(_REQUEST_ID),
            "owner_user_id": "owner",
            "buyer_user_id": "buyer",
            "domain": "personal_data",
            "scope_handle": "s_insurance123",
            "status": status,
            "duration_days": 1,
            "resolved_at": datetime.now(UTC),
            "latest_envelope_id": _ENVELOPE_ID,
            "metadata": {"machine_scope": _SCOPE, "approved_duration_seconds": 3600},
        }
        self.key = {
            "key_id": "buyer-key-1",
            "user_id": "buyer",
            "algorithm": "ECDH-P256-AES256-GCM",
        }
        self.envelope = {
            "id": _ENVELOPE_ID,
            "request_id": UUID(_REQUEST_ID),
            "owner_user_id": "owner",
            "buyer_user_id": "buyer",
            "recipient_key_id": "buyer-key-1",
            "ciphertext": "sealed",
            "iv": "iv",
            "sender_ephemeral_public_key_jwk": {"kty": "EC", "crv": "P-256"},
            "metadata": {"scope": _SCOPE},
        }
        self.lock = asyncio.Lock()
        self.task = None
        self.calls = []
        self.insert_started = None
        self.release_insert = None

    @asynccontextmanager
    async def transaction(self):
        task = asyncio.current_task()
        nested = self.task is task
        if not nested:
            await self.lock.acquire()
            self.task = task
        before = copy.deepcopy((self.request, self.key, self.envelope))
        try:
            yield self
        except Exception:
            self.request, self.key, self.envelope = before
            raise
        finally:
            if not nested:
                self.task = None
                self.lock.release()

    async def execute(self, sql, *args):
        self.calls.append(sql)
        if "latest_envelope_id=$2" in sql:
            self.request["latest_envelope_id"] = args[1]
        if "DELETE FROM marketplace_delivery_envelopes" in sql:
            self.envelope = None

    async def fetchrow(self, sql, *args):
        self.calls.append(sql)
        if "SELECT * FROM marketplace_access_requests" in sql:
            return copy.deepcopy(self.request) if args[0] == self.request["id"] else None
        if "scope_commerce_tariffs" in sql:
            return None
        if "SELECT * FROM marketplace_recipient_keys" in sql:
            return copy.deepcopy(self.key)
        if "UPDATE marketplace_access_requests SET status='approved'" in sql:
            self.request.update(
                status="approved", resolved_at=datetime.now(UTC), metadata=json.loads(args[1])
            )
            return copy.deepcopy(self.request)
        if "UPDATE marketplace_access_requests SET status='revoked'" in sql:
            self.request.update(status="revoked", latest_envelope_id=None)
            return copy.deepcopy(self.request)
        if "INSERT INTO marketplace_delivery_envelopes" in sql:
            if self.insert_started:
                self.insert_started.set()
                await self.release_insert.wait()
            self.envelope = {
                "id": _ENVELOPE_ID,
                "request_id": args[0],
                "owner_user_id": args[1],
                "buyer_user_id": args[2],
                "recipient_key_id": args[3],
                "algorithm": args[4],
                "ciphertext": args[5],
                "iv": args[6],
                "sender_ephemeral_public_key_jwk": json.loads(args[7]),
                "metadata": json.loads(args[8]),
            }
            return copy.deepcopy(self.envelope)
        if "SELECT * FROM marketplace_delivery_envelopes" in sql:
            env = self.envelope
            if env and all(
                env[key] == value
                for key, value in zip(
                    ("id", "request_id", "owner_user_id", "buyer_user_id", "recipient_key_id"),
                    args,
                    strict=True,
                )
            ):
                return copy.deepcopy(env)
            return None
        raise AssertionError(sql)


class _Pool:
    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def acquire(self):
        yield self.conn


def _transactional_service(*, status="approved"):
    conn = _Connection(status=status)
    service = MarketplaceRequestService()
    service._pool = _Pool(conn)
    return service, conn


def _sealed(**overrides):
    return {
        "ciphertext": "sealed",
        "iv": "iv",
        "recipientKeyId": "buyer-key-1",
        "senderEphemeralPublicKeyJwk": {"kty": "EC", "crv": "P-256"},
        "metadata": {"scope": _SCOPE, "request_id": _REQUEST_ID},
        **overrides,
    }


@pytest.mark.parametrize("state", ["pending", "denied", "expired", "revoked"])
async def test_delivery_reader_denies_nonapproved_even_if_ciphertext_survives(state):
    service, conn = _transactional_service(status=state)
    result = await service.get_delivered_envelope(buyer_user_id="buyer", request_id=_REQUEST_ID)
    assert result["envelope"] is None
    assert not any("SELECT * FROM marketplace_delivery_envelopes" in sql for sql in conn.calls)


async def test_delivery_reader_uses_expiry_pointer_owner_and_current_recipient():
    service, conn = _transactional_service()
    assert (await service.get_delivered_envelope(buyer_user_id="buyer", request_id=_REQUEST_ID))[
        "envelope"
    ]["ciphertext"] == "sealed"
    assert (
        await service.get_delivered_envelope(buyer_user_id="other", request_id=_REQUEST_ID) is None
    )
    conn.key["key_id"] = "new-key-1"
    assert (await service.get_delivered_envelope(buyer_user_id="buyer", request_id=_REQUEST_ID))[
        "envelope"
    ] is None
    conn.key["key_id"] = "buyer-key-1"
    conn.request["resolved_at"] -= timedelta(hours=2)
    assert (await service.get_delivered_envelope(buyer_user_id="buyer", request_id=_REQUEST_ID))[
        "envelope"
    ] is None


async def test_paid_marketplace_delivery_returns_canonical_package_only_after_admission(
    monkeypatch,
):
    from hushh_mcp.consent import paid_admission

    service, conn = _transactional_service()
    conn.request["metadata"] = {"commercial_required": True}
    fetch = conn.fetchrow
    admitted = False
    reads = []

    async def admission(*args, **kwargs):
        assert kwargs["connection"] is conn
        return admitted

    async def paid_fetch(sql, *args):
        if "FROM consent_audit" in sql:
            return {
                "token_id": "server-only-token",
                "metadata": {"commercial_required": True, "commerce_purchase_id": "purchase"},
            }
        if "FROM consent_exports" in sql:
            reads.append(sql)
            return {
                "encrypted_data": "canonical-ciphertext",
                "iv": "iv",
                "tag": "tag",
                "scope": _SCOPE,
                "refresh_status": "current",
                "envelope_version": 2,
                "export_id": _ENVELOPE_ID,
                "envelope_aad": {"machine_scope": _SCOPE},
                "wrapped_key_bundle": {
                    "wrapped_export_key": "wrapped",
                    "wrapped_key_iv": "iv",
                    "wrapped_key_tag": "tag",
                    "sender_public_key": "sender",
                    "wrapping_alg": "X25519-AES256-GCM",
                    "connector_key_id": "one-key",
                },
            }
        return await fetch(sql, *args)

    monkeypatch.setattr(paid_admission, "paid_grant_is_admitted", admission)
    monkeypatch.setattr(conn, "fetchrow", paid_fetch)
    denied = await service.get_delivered_envelope(buyer_user_id="buyer", request_id=_REQUEST_ID)
    assert denied["encryptedExport"] is None
    assert reads == []
    admitted = True
    result = await service.get_delivered_envelope(buyer_user_id="buyer", request_id=_REQUEST_ID)
    assert result["envelope"] is None
    assert result["encryptedExport"]["encrypted_data"] == "canonical-ciphertext"
    assert result["encryptedExport"]["export_envelope"]["version"] == 2
    assert "server-only-token" not in json.dumps(result, default=str)


async def test_approval_rolls_back_when_exact_scope_or_recipient_changed():
    service, conn = _transactional_service(status="pending")
    with pytest.raises(ValueError, match="exact approved scope"):
        await service.approve_request(
            owner_user_id="owner",
            request_id=_REQUEST_ID,
            envelope=_sealed(metadata={"scope": "attr.personal_data.*"}),
        )
    assert conn.request["status"] == "pending"
    with pytest.raises(ValueError, match="recipient key changed"):
        await service.approve_request(
            owner_user_id="owner",
            request_id=_REQUEST_ID,
            envelope=_sealed(recipientKeyId="old-key-1"),
        )
    assert conn.request["status"] == "pending"
    result = await service.approve_request(
        owner_user_id="owner", request_id=_REQUEST_ID, envelope=_sealed(), duration_seconds=1800
    )
    assert result["ok"]
    assert conn.request["metadata"]["approved_duration_seconds"] == 1800


async def test_revoke_cannot_race_delivery_into_a_usable_envelope():
    service, conn = _transactional_service()
    conn.insert_started, conn.release_insert = asyncio.Event(), asyncio.Event()
    delivery = asyncio.create_task(
        service.deliver_envelope(owner_user_id="owner", request_id=_REQUEST_ID, envelope=_sealed())
    )
    await conn.insert_started.wait()
    revoke = asyncio.create_task(
        service.revoke_request(owner_user_id="owner", request_id=_REQUEST_ID)
    )
    await asyncio.sleep(0)
    assert not revoke.done()
    conn.release_insert.set()
    await delivery
    assert (await revoke)["ok"]
    assert conn.request["status"] == "revoked"
    assert conn.request["latest_envelope_id"] is None
    assert (await service.get_delivered_envelope(buyer_user_id="buyer", request_id=_REQUEST_ID))[
        "envelope"
    ] is None


async def test_legacy_price_is_never_payment_proof_and_paid_cannot_use_legacy_relay():
    service, conn = _transactional_service()
    conn.request["price_cents"] = 99999
    conn.request["metadata"]["commercial_required"] = True
    with pytest.raises(ValueError, match="canonical encrypted export stage"):
        await service.deliver_envelope(
            owner_user_id="owner", request_id=_REQUEST_ID, envelope=_sealed()
        )
