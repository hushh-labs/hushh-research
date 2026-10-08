from __future__ import annotations

import base64
import hashlib

import pytest
from pydantic import ValidationError

from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    ciphertext_digest_from_base64,
    connector_key_fingerprint,
    digest_bytes,
    enforce_raw_byte_limit,
    normalize_refresh_policy,
    scope_handle_for_machine_scope,
    validate_export_envelope_submission,
)


@pytest.mark.asyncio
async def test_paid_grant_admission_preserves_free_and_fails_closed_across_time_key_and_flags(
    monkeypatch,
):
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.consent.paid_admission import paid_grant_is_admitted
    from hushh_mcp.services import scope_commerce_requests
    from hushh_mcp.services.scope_commerce import service as commerce

    now = datetime.now(UTC)
    purchase = {
        "purchase_id": "purchase",
        "request_id": "request",
        "owner_user_id": "owner",
        "payer_user_id": "payer",
        "buyer_app_id": "app",
        "machine_scope": "attr.financial.portfolio.*",
        "scope_handle": "s_exactscope",
        "recipient_key_fingerprint": "fingerprint",
        "status": "staged",
        "activation_at": now - timedelta(seconds=1),
        "expires_at": now + timedelta(hours=1),
    }
    binding = {**purchase, "consent_action": "CONSENT_GRANTED"}
    calls = []

    class ClockConnection:
        async def fetchval(self, *_args):
            return now

    conn = ClockConnection()

    class Service:
        async def _environment(self, connection):
            assert connection is conn

        async def lookup_by_consent_token(self, token, conn=None):
            calls.append(token)
            return dict(purchase)

    async def resolve(*args, **kwargs):
        return dict(binding)

    monkeypatch.setattr(commerce, "ScopeCommerceService", Service)
    monkeypatch.setattr(scope_commerce_requests, "resolve_commerce_request", resolve)
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    assert await paid_grant_is_admitted("free", {})
    assert calls == []
    metadata = {"commercial_required": True, "commerce_purchase_id": "purchase"}
    assert await paid_grant_is_admitted("canonical", metadata, connection=conn)
    purchase["activation_at"] = now + timedelta(minutes=1)
    assert not await paid_grant_is_admitted("canonical", metadata, connection=conn)
    purchase["activation_at"] = now - timedelta(minutes=1)
    purchase["expires_at"] = now - timedelta(seconds=1)
    assert not await paid_grant_is_admitted("canonical", metadata, connection=conn)
    purchase["expires_at"] = now + timedelta(hours=1)
    for state in ("revoked", "payment_disputed", "preparing"):
        purchase["status"] = state
        assert not await paid_grant_is_admitted("canonical", metadata, connection=conn)
    purchase["status"] = "staged"
    binding["recipient_key_fingerprint"] = "rotated"
    assert not await paid_grant_is_admitted("canonical", metadata, connection=conn)


@pytest.mark.asyncio
async def test_disabled_commerce_or_missing_paid_schema_cannot_downgrade_owner_approval(
    monkeypatch,
):
    from asyncpg import UndefinedTableError

    from hushh_mcp.consent import paid_admission
    from hushh_mcp.services.scope_commerce import service as commerce

    class Service:
        async def get_tariff(self, **kwargs):
            return {"priceCents": 1}

    async def disabled(*args, **kwargs):
        raise ValueError("commerce_unavailable")

    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    monkeypatch.setattr(commerce, "ScopeCommerceService", Service)
    monkeypatch.setattr(paid_admission, "approve_paid_request", disabled)
    from hushh_mcp.services import scope_commerce_requests

    async def registered(*args, **kwargs):
        return "s_registered123"

    monkeypatch.setattr(scope_commerce_requests, "authoritative_scope_handle", registered)

    async def pool_port():
        return object()

    monkeypatch.setattr(paid_admission, "get_pool", pool_port)
    params = {
        "owner_user_id": "owner",
        "request_id": "request",
        "machine_scope": "attr.financial.portfolio.*",
        "metadata": {},
        "duration_seconds": 3600,
    }
    with pytest.raises(ValueError, match="commerce_unavailable"):
        await paid_admission.maybe_approve_paid_request(**params)

    class Missing:
        async def get_tariff(self, **kwargs):
            raise UndefinedTableError()

    monkeypatch.setattr(commerce, "ScopeCommerceService", Missing)
    assert await paid_admission.maybe_approve_paid_request(**params) is None
    params["metadata"] = {"commercial_required": True}
    with pytest.raises(ValueError, match="paid_authorization_unavailable"):
        await paid_admission.maybe_approve_paid_request(**params)


@pytest.mark.asyncio
async def test_paid_export_source_fence_rejects_stale_content_and_manifest():
    from hushh_mcp.consent.paid_admission import verify_source_revisions

    class Connection:
        content = 4
        manifest = 3

        async def execute(self, *_args):
            pass

        async def fetchrow(self, *_args):
            return {"manifest_version": self.manifest}

        async def fetch(self, *_args):
            return [{"content_revision": self.content, "manifest_revision": self.manifest}]

    conn = Connection()
    await verify_source_revisions(
        conn, "owner", "attr.financial.portfolio.*", {"contentRevision": 4, "manifestRevision": 3}
    )
    for revisions in (
        {"contentRevision": 3, "manifestRevision": 3},
        {"contentRevision": 4, "manifestRevision": 2},
    ):
        with pytest.raises(ValueError, match="source_revision_changed"):
            await verify_source_revisions(conn, "owner", "attr.financial.portfolio.*", revisions)


@pytest.mark.asyncio
async def test_paid_owner_approval_replay_keeps_frozen_quote_after_tariff_change(monkeypatch):
    from hushh_mcp.consent.paid_admission import approve_paid_request
    from hushh_mcp.services import scope_commerce_requests
    from hushh_mcp.services.scope_commerce import service as commerce

    class Connection:
        async def execute(self, *_args):
            pass

    class Service:
        async def lookup_by_request(self, *args, **kwargs):
            return {"purchaseId": "purchase", "status": "revoked", "durationSeconds": 3600}

        async def get_quote_by_request(self, *args, **kwargs):
            return {"quoteId": "quote", "durationSeconds": 3600, "priceCents": 99}

        async def get_tariff(self, **kwargs):
            raise AssertionError("current tariff cannot rewrite an authorized quote")

    async def resolve(*args, **kwargs):
        return {"owner_user_id": "owner"}

    monkeypatch.setattr(commerce, "ScopeCommerceService", Service)
    monkeypatch.setattr(scope_commerce_requests, "resolve_commerce_request", resolve)
    result = await approve_paid_request("owner", "request", 3600, "replay", connection=Connection())
    assert result["quote"]["priceCents"] == 99
    assert result["status"] == "revoked"
    with pytest.raises(ValueError, match="approved_duration_is_immutable"):
        await approve_paid_request("owner", "request", 7200, "replay", connection=Connection())


@pytest.mark.asyncio
async def test_paid_purchase_cancellation_checks_actor_and_db_activation_before_mutation(
    monkeypatch,
):
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.consent.paid_admission import end_paid_purchase
    from hushh_mcp.services.consent_db import ConsentDBService
    from hushh_mcp.services.scope_commerce import service as commerce

    purchase_id = "123e4567-e89b-12d3-a456-426614174000"
    now = datetime.now(UTC)
    purchase = {
        "purchase_id": purchase_id,
        "request_id": "request",
        "owner_user_id": "owner",
        "payer_user_id": "buyer",
        "machine_scope": "attr.financial.portfolio.*",
        "status": "staged",
        "activation_at": now,
        "expires_at": now + timedelta(hours=1),
    }
    mutations = []
    events = []

    class Connection:
        async def execute(self, *_args):
            pass

        async def fetchrow(self, sql, *_args):
            if "scope_commerce_purchases" in sql:
                return dict(purchase)
            return {"agent_id": "app", "scope": purchase["machine_scope"], "metadata": {}}

        async def fetchval(self, *_args):
            return now

    class Service:
        async def revoke_purchase(self, **kwargs):
            mutations.append(kwargs)
            purchase["status"] = "revoked"
            return {"purchaseId": purchase_id, "status": "revoked"}

    async def event(self, **kwargs):
        events.append(kwargs)
        return 1

    monkeypatch.setattr(commerce, "ScopeCommerceService", Service)
    monkeypatch.setattr(ConsentDBService, "insert_event", event)
    conn = Connection()
    with pytest.raises(PermissionError, match="purchase_unavailable"):
        await end_paid_purchase("other", purchase_id, as_owner=True, connection=conn)
    with pytest.raises(ValueError, match="buyer_cancellation_after_activation_denied"):
        await end_paid_purchase("buyer", purchase_id, as_owner=False, connection=conn)
    assert mutations == events == []

    purchase["activation_at"] = now + timedelta(minutes=1)
    result = await end_paid_purchase("buyer", purchase_id, as_owner=False, connection=conn)
    assert result["status"] == "revoked"
    assert mutations[0]["owner_user_id"] == "owner"
    assert events[0]["action"] == "CANCELLED"
    await end_paid_purchase("buyer", purchase_id, as_owner=False, connection=conn)
    assert len(mutations) == len(events) == 1

    purchase["status"] = "staged"
    purchase["activation_at"] = now - timedelta(minutes=1)
    await end_paid_purchase("owner", purchase_id, as_owner=True, connection=conn)
    assert events[-1]["action"] == "REVOKED"


def _aad() -> ConsentExportAadV2:
    return ConsentExportAadV2(
        app_id="app_hushh",
        grant_id="req_grant_123",
        export_id="123e4567-e89b-12d3-a456-426614174000",
        revision=1,
        machine_scope="attr.financial.portfolio.*",
        scope_handle="s_portfolio_123",
        recipient_key_fingerprint=f"sha256:{'a' * 64}",
        expires_at_ms=1_800_000_000_000,
    )


def test_canonical_aad_is_stable_and_sorted() -> None:
    encoded = canonical_aad_bytes(_aad())
    assert encoded.startswith(b'{"app_id":"app_hushh"')
    assert b" " not in encoded
    assert digest_bytes(encoded) == f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def test_submission_validates_ciphertext_and_server_context() -> None:
    ciphertext = base64.b64encode(b"encrypted-payload").decode()
    ciphertext_digest, ciphertext_bytes = ciphertext_digest_from_base64(ciphertext)
    aad = _aad()
    envelope = ConsentExportEnvelopeSubmissionV2(
        export_id=aad.export_id,
        aad=aad,
        aad_sha256=digest_bytes(canonical_aad_bytes(aad)),
        ciphertext_sha256=ciphertext_digest,
        ciphertext_bytes=ciphertext_bytes,
    )

    validate_export_envelope_submission(
        envelope=envelope,
        encrypted_data=ciphertext,
        expected_app_id=aad.app_id,
        expected_grant_id=aad.grant_id,
        expected_revision=1,
        expected_scope=aad.machine_scope,
        expected_scope_handle=aad.scope_handle,
        expected_recipient_fingerprint=aad.recipient_key_fingerprint,
        expected_expires_at_ms=aad.expires_at_ms,
    )

    with pytest.raises(ValueError, match="export_ciphertext_digest_mismatch"):
        validate_export_envelope_submission(
            envelope=envelope,
            encrypted_data=base64.b64encode(b"tampered").decode(),
            expected_app_id=aad.app_id,
            expected_grant_id=aad.grant_id,
            expected_revision=1,
            expected_scope=aad.machine_scope,
            expected_scope_handle=aad.scope_handle,
            expected_recipient_fingerprint=aad.recipient_key_fingerprint,
            expected_expires_at_ms=aad.expires_at_ms,
        )


def test_envelope_rejects_aad_digest_or_export_identity_mismatch() -> None:
    aad = _aad()
    with pytest.raises(ValidationError, match="export_envelope_id_mismatch"):
        ConsentExportEnvelopeSubmissionV2(
            export_id="123e4567-e89b-12d3-a456-426614174999",
            aad=aad,
            aad_sha256=digest_bytes(canonical_aad_bytes(aad)),
            ciphertext_sha256=f"sha256:{'b' * 64}",
            ciphertext_bytes=1,
        )


def test_connector_fingerprint_is_sha256_of_raw_x25519_key() -> None:
    raw = bytes(range(32))
    encoded = base64.b64encode(raw).decode()
    assert connector_key_fingerprint(encoded) == f"sha256:{hashlib.sha256(raw).hexdigest()}"

    with pytest.raises(ValueError, match="connector_public_key_must_be_x25519_32_bytes"):
        connector_key_fingerprint(base64.b64encode(b"short").decode())


def test_unproven_refresh_policy_fails_closed_to_snapshot() -> None:
    assert normalize_refresh_policy("continuous_until_expiry") == "continuous_until_expiry"
    assert normalize_refresh_policy("unknown") == "snapshot"
    assert normalize_refresh_policy(None) == "snapshot"


def test_scope_handle_fallback_is_stable_and_subject_bound() -> None:
    first = scope_handle_for_machine_scope("user_a", "attr.financial.*")
    assert first == scope_handle_for_machine_scope("user_a", "attr.financial.*")
    assert first != scope_handle_for_machine_scope("user_b", "attr.financial.*")
    assert first.startswith("s_")


@pytest.mark.parametrize("raw_bytes", [1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1])
def test_one_megabyte_is_not_a_protocol_split_boundary(raw_bytes: int) -> None:
    encoded = base64.b64encode(b"x" * raw_bytes).decode()
    _digest, measured = ciphertext_digest_from_base64(encoded)
    enforce_raw_byte_limit(measured, 2 * 1024 * 1024)
    assert measured == raw_bytes


def test_configured_raw_byte_maximum_is_inclusive_and_max_plus_one_fails() -> None:
    enforce_raw_byte_limit(1024, 1024)
    with pytest.raises(ValueError, match="PAYLOAD_TOO_LARGE"):
        enforce_raw_byte_limit(1025, 1024)


def _independent_term_rows(expiry: int) -> dict:
    return {
        "free": {
            "token_id": "free",
            "action": "CONSENT_GRANTED",
            "metadata": {},
            "expires_at": expiry,
        },
        "paid_a": {
            "token_id": "paid_a",
            "action": "CONSENT_GRANTED",
            "metadata": {"commercial_required": True, "commerce_purchase_id": "a"},
            "expires_at": expiry,
        },
        "paid_b": {
            "token_id": "paid_b",
            "action": "CONSENT_GRANTED",
            "metadata": {"commercial_required": True, "commerce_purchase_id": "b"},
            "expires_at": expiry,
        },
    }


@pytest.mark.asyncio
async def test_exact_paid_terms_do_not_supersede_each_other_or_an_existing_free_grant(monkeypatch):
    import time
    from types import SimpleNamespace

    from hushh_mcp.consent import paid_admission
    from hushh_mcp.services.consent_db import ConsentDBService

    expiry = int(time.time() * 1000) + 3600000
    rows = _independent_term_rows(expiry)

    class Query:
        token = None

        def select(self, *args):
            return self

        def eq(self, key, value):
            if key == "token_id":
                self.token = value
            return self

        def in_(self, *args):
            return self

        def order(self, *args, **kwargs):
            return self

        def limit(self, *args):
            return self

        def execute(self):
            return SimpleNamespace(data=[rows.get(self.token, rows["paid_b"])])

    class Database:
        def table(self, *args):
            return Query()

        def execute_raw(self, sql, params):
            assert "NOT EXISTS" in sql
            return SimpleNamespace(data=[rows["free"]])

    service = ConsentDBService()
    monkeypatch.setattr(service, "_get_db", lambda: Database())
    admissions = []

    async def admitted(token, metadata, **kwargs):
        if metadata.get("commercial_required"):
            admissions.append((token, metadata["commerce_purchase_id"]))
        return True

    monkeypatch.setattr(paid_admission, "paid_grant_is_admitted", admitted)
    for token in rows:
        assert await service.is_token_active(
            "owner", "attr.financial.portfolio.*", "app", token_id=token
        )
    assert admissions == [("paid_a", "a"), ("paid_b", "b")]
    rows["free"]["expires_at"] = 0
    assert not await service.is_token_active(
        "owner",
        "attr.financial.portfolio.*",
        "app",
        token_id="free",  # noqa: S106 - synthetic ledger ID
    )
