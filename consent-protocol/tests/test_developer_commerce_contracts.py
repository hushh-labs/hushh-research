"""Commercial developer boundaries: payer identity, consent and opaque delivery."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api.routes import developer
from tests.developer_contract_harness import (
    _CONNECTOR_KEY_ID as _CONNECTOR_KEY_ID,
)
from tests.developer_contract_harness import (
    _CONNECTOR_PUBLIC_KEY as _CONNECTOR_PUBLIC_KEY,
)
from tests.developer_contract_harness import (
    _CONNECTOR_WRAPPING_ALG as _CONNECTOR_WRAPPING_ALG,
)
from tests.developer_contract_harness import (
    _build_app as _build_app,
)
from tests.developer_contract_harness import (
    _fake_principal as _fake_principal,
)
from tests.developer_contract_harness import (
    _isolate_developer_registry_keys as _isolate_developer_registry_keys,
)
from tests.developer_contract_harness import (
    _offer_fakes as _offer_fakes,
)

_EXPECTED_MCP_READ_AUDIT = {
    "event_schema": "consent_export_read/v1",
    "event_kind": "export_issued",
    "outcome": "released",
    "app_id": "app_demo_123",
    "grant_ref": None,
    "export_id": "a" * 32,
    "export_revision": 1,
    "expected_scope": "attr.financial.portfolio.*",
    "coverage_kind": "exact",
    "connector_key_id": "connector_demo",
    "recipient_key_fingerprint": None,
    "wrapping_alg": None,
    "delivery_surface": "mcp_inline",
    "delivered_bytes": 128,
    "correlation_ref": None,
}


def _paid_registration(monkeypatch, owner_uid: str | None, registered: bool) -> None:
    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "get_app",
        lambda _self, _app_id: {"owner_firebase_uid": owner_uid},
    )
    monkeypatch.setattr(
        developer.DeveloperRegistryService,
        "get_active_connector_key",
        lambda _self, **_kwargs: (
            {
                "connector_key_id": _CONNECTOR_KEY_ID,
                "connector_public_key": _CONNECTOR_PUBLIC_KEY,
                "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
            }
            if registered
            else None
        ),
    )


def test_mcp_offer_reaches_canonical_consent_without_authorizing_payment(monkeypatch):
    inserted: dict[str, object] = {}
    _offer_fakes(monkeypatch, inserted)
    monkeypatch.setattr(
        developer,
        "_resolve_mcp_user_identifier",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="owner_internal"),
    )
    response = TestClient(_build_app()).post(
        "/api/v1/mcp/request-consent",
        headers={"Authorization": "Bearer hdk_demo"},
        json={
            "user_identifier": "private@example.com",
            "scope": "attr.financial.portfolio.*",
            "purpose": "Prepare an approved portfolio summary.",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
            "offer": {"bid_amount": 0.01, "settlement_ref": "unverified-receipt"},
        },
    )
    assert response.status_code == 200
    assert inserted["metadata"]["offer_bid_amount"] == 0.01
    assert response.json()["status"] == "pending"
    assert response.json()["offer"]["settlement_status"] == "pending_user_clearance"
    assert "grant_ref" not in response.json()
    assert "private@example.com" not in response.text
    assert "owner_internal" not in response.text


@pytest.mark.parametrize(
    "owner_uid,enabled,registered,expected",
    [
        ("payer_internal", "true", True, 200),
        (None, "true", True, 409),
        ("payer_internal", "false", True, 409),
        ("payer_internal", "true", False, 409),
    ],
)
def test_paid_request_uses_tariff_estimate_without_creating_quote_or_reusing_free_grant(
    monkeypatch,
    owner_uid,
    enabled,
    registered,
    expected,
):
    inserted: dict[str, object] = {}
    tariff_calls: list[dict] = []
    _offer_fakes(monkeypatch, inserted)
    monkeypatch.delenv("DB_OFFLINE", raising=False)
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", enabled)
    tariff = {
        "scopeHandle": "s_owner_scope",
        "machineScope": "attr.financial.portfolio.*",
        "priceCents": 1,
        "baseDurationSeconds": 86400,
        "tariffRevision": 2,
    }

    class _Commerce:
        async def get_tariff(self, **_kwargs):
            tariff_calls.append(_kwargs)
            return tariff

        async def list_tariffs(self, **_kwargs):
            return [tariff]

        async def quote(self, **_kwargs):
            raise AssertionError("MCP credentials cannot create an accepted quote")

    monkeypatch.setattr(developer, "_commerce_service", _Commerce)
    _paid_registration(monkeypatch, owner_uid, registered)
    monkeypatch.setattr(
        developer,
        "_resolve_strict_covering_active_token",
        lambda **_kwargs: asyncio.sleep(
            0,
            result=(
                {
                    "token_id": "HCT:old-free-grant",
                    "scope": "attr.financial.portfolio.*",
                    "request_id": "req_" + "0" * 28,
                    "metadata": {},
                },
                {"is_strict_zero_knowledge": True},
                False,
            ),
        ),
    )
    response = TestClient(_build_app()).post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "owner_internal",
            "scope": "attr.financial.portfolio.*",
            "reason": "Prepare an approved portfolio summary.",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )
    assert response.status_code == expected
    assert tariff_calls[0]["machine_scope"] == "attr.financial.portfolio.*"
    if expected != 200:
        assert inserted == {}
        if enabled == "true" and owner_uid and not registered:
            assert response.json()["detail"]["error_code"] == "REGISTERED_RECIPIENT_KEY_REQUIRED"
        return
    assert response.json()["status"] == "pending"
    assert response.json()["tariff_price_cents"] == 1
    assert "quote_ref" not in response.json()
    assert "consent_token" not in response.json()
    assert inserted["metadata"]["commercial_required"] is True
    assert "commerce_quote_id" not in inserted["metadata"]


def test_tariff_store_failure_cannot_downgrade_paid_access_to_free(monkeypatch):
    inserted: dict[str, object] = {}
    _offer_fakes(monkeypatch, inserted)
    monkeypatch.delenv("DB_OFFLINE", raising=False)
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")

    class _BrokenCommerce:
        async def list_tariffs(self, **_kwargs):
            raise RuntimeError("private storage diagnostics")

    monkeypatch.setattr(developer, "_commerce_service", _BrokenCommerce)
    response = TestClient(_build_app()).post(
        "/api/v1/request-consent?token=hdk_demo",
        json={
            "user_id": "owner_internal",
            "scope": "attr.financial.portfolio.*",
            "reason": "Prepare an approved portfolio summary.",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        },
    )
    assert response.status_code == 503
    assert response.json()["detail"]["error_code"] == "SCOPE_COMMERCE_UNAVAILABLE"
    assert "private storage diagnostics" not in response.text
    assert inserted == {}


def test_mcp_paid_grant_stays_pending_before_fixed_activation_even_with_feature_off(monkeypatch):
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    request_id = "req_" + "0" * 28

    class _Consent:
        async def get_request_status_for_agent(self, _request_ref, **_kwargs):
            return {
                "request_id": request_id,
                "action": "CONSENT_GRANTED",
                "scope": "attr.financial.portfolio.*",
                "token_id": "HCT:staged-token",
                "metadata": {"commercial_required": True, "commerce_quote_id": "quote_internal"},
            }

    class _Commerce:
        async def request_status(self, **_kwargs):
            return {
                "status": "armed",
                "quoteId": "quote_internal",
                "priceCents": 1,
                "activationAt": "2099-01-01T00:00:00+00:00",
                "expiresAt": "2099-01-02T00:00:00+00:00",
            }

    async def _token_must_not_be_exposed(*_args, **_kwargs):
        raise AssertionError("A staged paid token is not an advertised grant")

    monkeypatch.setattr(developer, "ConsentDBService", _Consent)
    monkeypatch.setattr(developer, "_commerce_service", _Commerce)
    monkeypatch.setattr(developer, "validate_token_with_db", _token_must_not_be_exposed)
    response = TestClient(_build_app()).get(
        f"/api/v1/mcp/consent-status/{request_id}", headers={"Authorization": "Bearer hdk_demo"}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert response.json()["access_state"] == "armed"
    assert response.json()["grant_ref"] is None
    assert "HCT:" not in response.text


@pytest.mark.parametrize(
    "grant_metadata,paid",
    [
        ({}, False),
        ({"commercial_required": True}, True),
        ({"commerce_purchase_id": "purchase"}, True),
    ],
)
def test_mcp_export_resolves_internal_token_by_app_and_grant(monkeypatch, grant_metadata, paid):
    audit_events: list[dict[str, object]] = []

    class _FakeConsentDBService:
        async def get_consent_export_by_grant(self, grant_id: str, *, app_id: str):
            assert grant_id == "req_0123456789abcdef0123456789ab"
            assert app_id == "app_demo_123"
            return {
                "consent_token": "HCT:internal-only",
                "user_id": "firebase_uid_internal",
            }

        async def insert_event(self, **kwargs):
            audit_events.append(kwargs)
            return 1

    async def _load(**kwargs):
        assert kwargs["consent_token"] == "HCT:internal-only"
        assert kwargs["user_id"] == "firebase_uid_internal"
        return (
            _fake_principal(),
            SimpleNamespace(
                scope_str="attr.financial.portfolio.*",
                scope=SimpleNamespace(value="attr.financial.portfolio.*"),
                expires_at=123456789,
            ),
            {
                "scope": "attr.financial.portfolio.*",
                "is_strict_zero_knowledge": True,
                "envelope_version": 2,
                "export_id": "a" * 32,
                "export_revision": 1,
                "iv": "iv",
                "tag": "tag",
                "wrapped_key_bundle": {"connector_key_id": "connector_demo"},
                "envelope_aad": {"grant_id": "req_0123456789abcdef0123456789ab"},
                "envelope_aad_sha256": "b" * 64,
                "ciphertext_sha256": "c" * 64,
                "ciphertext_bytes": 128,
                "_grant_metadata": grant_metadata,
            },
        )

    monkeypatch.setattr(developer, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(developer, "_load_scoped_export_or_raise", _load)
    monkeypatch.setattr(
        developer, "authenticate_developer_principal", lambda **_: _fake_principal()
    )
    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/mcp/scoped-export",
        headers={"Authorization": "Bearer hdk_demo"},
        json={
            "grant_ref": "req_0123456789abcdef0123456789ab",
            "expected_scope": "attr.financial.portfolio.*",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["commercial_required"] is paid
    assert "HCT:internal-only" not in response.text
    assert "firebase_uid_internal" not in response.text
    assert len(audit_events) == 1
    assert audit_events[0]["action"] == "READ"
    assert "request_id" not in audit_events[0]
    assert audit_events[0]["metadata"] == _EXPECTED_MCP_READ_AUDIT


def test_offline_free_classification_rejects_persisted_or_unknown_paid_authority(
    monkeypatch, tmp_path
):
    import sqlite3

    from api.routes.developer_commerce import offline_free_context

    path = tmp_path / "offline.db"
    monkeypatch.setenv("OFFLINE_DB_PATH", str(path))
    monkeypatch.setenv("DB_OFFLINE", "true")
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    assert offline_free_context() and not path.exists()
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE consent_audit(metadata TEXT)")
        c.execute("INSERT INTO consent_audit VALUES('{}')")
    assert offline_free_context()
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE scope_commerce_tariffs(price_cents INTEGER)")
        c.execute("INSERT INTO scope_commerce_tariffs VALUES(1)")
    assert not offline_free_context()
    with sqlite3.connect(path) as c:
        c.execute("DROP TABLE scope_commerce_tariffs")
        c.execute("INSERT INTO consent_audit VALUES(?)", ('{"commercial_required":true}',))
    assert not offline_free_context()
    path.write_bytes(b"not a SQLite database")
    assert not offline_free_context()
