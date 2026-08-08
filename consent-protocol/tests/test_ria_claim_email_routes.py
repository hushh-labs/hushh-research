"""Routes for the claim email upgrade: /claim/email/start and /claim/email/confirm.

The plaintext verification code must never appear in any HTTP response — the
happy-path tests assert its absence from the serialized body, not just its
absence from a named field.
"""

from __future__ import annotations

import sys
import types
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

# Stub the rate-limit middleware *before* importing the route module so the
# decorator is a no-op during tests (same pattern as test_ria_claim_flow).
rate_limit_module = types.ModuleType("api.middlewares.rate_limit")


class _NoopLimiter:
    def limit(self, *_args, **_kwargs):
        def decorator(func):
            return func

        return decorator


rate_limit_module.limiter = _NoopLimiter()
sys.modules.setdefault("api.middlewares.rate_limit", rate_limit_module)

import hushh_mcp.services.ria_claim_email_service as email_module  # noqa: E402
from api.middleware import require_firebase_auth  # noqa: E402
from api.routes import ria as ria_module  # noqa: E402
from hushh_mcp.services.actor_identity_service import ActorIdentityAliasError  # noqa: E402
from hushh_mcp.services.ria_claim_email_service import (  # noqa: E402
    queue_claim_verification_email,
)
from hushh_mcp.services.ria_claim_service import (  # noqa: E402
    RIAClaimEmailError,
    RIAClaimService,
)

_TEST_UID = "user_claim_123"
_PLAINTEXT_CODE = "483920"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ria_module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _TEST_UID
    return app


def _prepared() -> dict[str, Any]:
    return {
        "email": "reg@olympuspeaks.com",
        "email_masked": "r•••@olympuspeaks.com",
        "firm_name": "Olympus Peaks Financial, LLC",
    }


def _alias_result(*, already_verified: bool = False) -> dict[str, Any]:
    return {
        "alias": {
            "alias_id": "alias-1",
            "email": "reg@olympuspeaks.com",
            "email_normalized": "reg@olympuspeaks.com",
            "verification_status": "verified" if already_verified else "pending",
            "revoked_at": None,
        },
        "already_verified": already_verified,
        "review_verification_code": None,
        "verification_code_plaintext": None if already_verified else _PLAINTEXT_CODE,
    }


def _mock_start_dependencies(
    monkeypatch,
    *,
    alias_result: dict[str, Any] | None = None,
    delivery: dict[str, str] | None = None,
) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    async def _mock_prepare(self, user_id, email):
        captured["prepare"] = {"user_id": user_id, "email": email}
        return _prepared()

    monkeypatch.setattr(RIAClaimService, "prepare_email_verification", _mock_prepare)

    async def _mock_request(
        self, *, user_id, email, verification_source, source_ref, include_plaintext_code=False
    ):
        captured["request"] = {
            "user_id": user_id,
            "email": email,
            "source_ref": source_ref,
            "include_plaintext_code": include_plaintext_code,
        }
        return dict(alias_result if alias_result is not None else _alias_result())

    monkeypatch.setattr(
        ria_module.ActorIdentityService, "request_email_alias_verification", _mock_request
    )

    async def _mock_queue(*, target_email, verification_code, firm_name=None):
        captured["queue"] = {
            "target_email": target_email,
            "verification_code": verification_code,
            "firm_name": firm_name,
        }
        return dict(delivery if delivery is not None else {"delivery_status": "queued"})

    monkeypatch.setattr(ria_module, "queue_claim_verification_email", _mock_queue)
    return captured


# ---------------------------------------------------------------------------
# /claim/email/start
# ---------------------------------------------------------------------------


def test_email_start_sends_and_never_leaks_the_code(monkeypatch):
    captured = _mock_start_dependencies(monkeypatch)
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/email/start", json={"email": "Reg@OlympusPeaks.com"})
    assert response.status_code == 200
    assert response.json() == {"status": "sent", "email_masked": "r•••@olympuspeaks.com"}
    # The plaintext travels only through the route-internal opt-in handoff.
    assert captured["request"]["include_plaintext_code"] is True
    # The plaintext code reached the mail queue and ONLY the mail queue.
    assert captured["queue"]["verification_code"] == _PLAINTEXT_CODE
    assert _PLAINTEXT_CODE not in response.text


def test_email_start_queue_failure_returns_send_failed_without_raising(monkeypatch):
    _mock_start_dependencies(
        monkeypatch, delivery={"delivery_status": "failed", "reason": "not_configured"}
    )
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/email/start", json={"email": "reg@olympuspeaks.com"})
    assert response.status_code == 502
    assert response.json()["status"] == "send_failed"
    assert _PLAINTEXT_CODE not in response.text


def test_email_start_already_verified_short_circuits(monkeypatch):
    captured = _mock_start_dependencies(
        monkeypatch, alias_result=_alias_result(already_verified=True)
    )
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/email/start", json={"email": "reg@olympuspeaks.com"})
    assert response.status_code == 200
    assert response.json()["status"] == "already_verified"
    assert "queue" not in captured


def test_email_start_domain_mismatch(monkeypatch):
    async def _mock_prepare(self, user_id, email):
        raise RIAClaimEmailError(
            "This email doesn't match your firm's website domain.",
            code="EMAIL_DOMAIN_MISMATCH",
        )

    monkeypatch.setattr(RIAClaimService, "prepare_email_verification", _mock_prepare)
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/email/start", json={"email": "reg@gmail.com"})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "EMAIL_DOMAIN_MISMATCH"


def test_email_start_missing_claim_context(monkeypatch):
    async def _mock_prepare(self, user_id, email):
        raise RIAClaimEmailError(
            "Claim your profile before verifying a work email.",
            code="CLAIM_CONTEXT_MISSING",
        )

    monkeypatch.setattr(RIAClaimService, "prepare_email_verification", _mock_prepare)
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/email/start", json={"email": "reg@olympuspeaks.com"})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CLAIM_CONTEXT_MISSING"


def test_email_start_alias_owned_elsewhere(monkeypatch):
    async def _mock_prepare(self, user_id, email):
        return _prepared()

    monkeypatch.setattr(RIAClaimService, "prepare_email_verification", _mock_prepare)

    async def _mock_request(
        self, *, user_id, email, verification_source, source_ref, include_plaintext_code=False
    ):
        raise ActorIdentityAliasError(
            "This email alias is already verified for another account.",
            code="EMAIL_ALIAS_ALREADY_VERIFIED",
            status_code=409,
        )

    monkeypatch.setattr(
        ria_module.ActorIdentityService, "request_email_alias_verification", _mock_request
    )
    client = TestClient(_build_app())
    response = client.post("/api/ria/claim/email/start", json={"email": "reg@olympuspeaks.com"})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "EMAIL_ALIAS_ALREADY_VERIFIED"


# ---------------------------------------------------------------------------
# /claim/email/confirm
# ---------------------------------------------------------------------------


def test_email_confirm_upgrades_when_evaluator_verifies(monkeypatch):
    async def _mock_confirm(self, *, user_id, email, verification_code, accept_without_code=False):
        assert user_id == _TEST_UID
        assert verification_code == _PLAINTEXT_CODE
        return {"email_normalized": email, "verification_status": "verified"}

    monkeypatch.setattr(
        ria_module.ActorIdentityService, "confirm_email_alias_verification", _mock_confirm
    )

    async def _mock_upgrade(self, user_id, *, email):
        return {
            "verified": True,
            "verification_status": "verified",
            "verification_level": "verified",
        }

    monkeypatch.setattr(RIAClaimService, "upgrade_with_email_evidence", _mock_upgrade)
    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/claim/email/confirm",
        json={"email": "reg@olympuspeaks.com", "code": _PLAINTEXT_CODE},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["verified"] is True
    assert body["verification_status"] == "verified"


def test_email_confirm_reports_unverified_without_writing(monkeypatch):
    async def _mock_confirm(self, *, user_id, email, verification_code, accept_without_code=False):
        return {"email_normalized": email, "verification_status": "verified"}

    monkeypatch.setattr(
        ria_module.ActorIdentityService, "confirm_email_alias_verification", _mock_confirm
    )

    async def _mock_upgrade(self, user_id, *, email):
        return {
            "verified": False,
            "verification_status": "submitted",
            "verification_level": "provisional",
        }

    monkeypatch.setattr(RIAClaimService, "upgrade_with_email_evidence", _mock_upgrade)
    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/claim/email/confirm",
        json={"email": "reg@olympuspeaks.com", "code": _PLAINTEXT_CODE},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["verified"] is False
    assert body["verification_status"] == "submitted"


def test_email_confirm_rejects_a_bad_code(monkeypatch):
    async def _mock_confirm(self, *, user_id, email, verification_code, accept_without_code=False):
        raise ActorIdentityAliasError(
            "Email alias verification code is invalid.",
            code="EMAIL_ALIAS_CODE_INVALID",
            status_code=400,
        )

    monkeypatch.setattr(
        ria_module.ActorIdentityService, "confirm_email_alias_verification", _mock_confirm
    )
    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/claim/email/confirm",
        json={"email": "reg@olympuspeaks.com", "code": "000000"},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "EMAIL_ALIAS_CODE_INVALID"


# ---------------------------------------------------------------------------
# Plaintext code contract
# ---------------------------------------------------------------------------


def test_plaintext_code_is_opt_in_only():
    """`/api/account/email-aliases/verification/start` serializes the service
    result verbatim, so the plaintext key must never appear unless a route
    explicitly opts in and pops it before responding."""
    import inspect

    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    signature = inspect.signature(ActorIdentityService.request_email_alias_verification)
    assert signature.parameters["include_plaintext_code"].default is False


# ---------------------------------------------------------------------------
# Best-effort mail: the queue helper never raises
# ---------------------------------------------------------------------------


class _StubEmailService:
    def __init__(self, *, configured: bool):
        self.config = types.SimpleNamespace(configured=configured)

    def send_verification_code(self, **_kwargs):  # pragma: no cover - queued only
        raise AssertionError("send should only run inside the queue worker")


async def test_queue_helper_reports_failed_when_unconfigured(monkeypatch):
    monkeypatch.setattr(
        email_module, "get_ria_claim_email_service", lambda: _StubEmailService(configured=False)
    )
    result = await queue_claim_verification_email(
        target_email="reg@olympuspeaks.com", verification_code=_PLAINTEXT_CODE
    )
    assert result == {"delivery_status": "failed", "reason": "not_configured"}


async def test_queue_helper_reports_failed_when_enqueue_raises(monkeypatch):
    monkeypatch.setattr(
        email_module, "get_ria_claim_email_service", lambda: _StubEmailService(configured=True)
    )

    class _BrokenQueue:
        async def enqueue(self, **_kwargs):
            raise RuntimeError("queue unavailable")

    monkeypatch.setattr(email_module, "get_email_delivery_queue_service", lambda: _BrokenQueue())
    result = await queue_claim_verification_email(
        target_email="reg@olympuspeaks.com", verification_code=_PLAINTEXT_CODE
    )
    assert result == {"delivery_status": "failed", "reason": "enqueue_failed"}


async def test_queue_helper_refuses_an_empty_code(monkeypatch):
    monkeypatch.setattr(
        email_module, "get_ria_claim_email_service", lambda: _StubEmailService(configured=True)
    )
    result = await queue_claim_verification_email(
        target_email="reg@olympuspeaks.com", verification_code=""
    )
    assert result == {"delivery_status": "failed", "reason": "missing_code"}


async def test_queue_helper_queues_when_configured(monkeypatch):
    monkeypatch.setattr(
        email_module, "get_ria_claim_email_service", lambda: _StubEmailService(configured=True)
    )
    enqueued: dict[str, Any] = {}

    class _Queue:
        async def enqueue(self, **kwargs):
            enqueued.update(kwargs)
            return {"accepted": True, "delivery_status": "queued"}

    monkeypatch.setattr(email_module, "get_email_delivery_queue_service", lambda: _Queue())
    result = await queue_claim_verification_email(
        target_email="reg@olympuspeaks.com",
        verification_code=_PLAINTEXT_CODE,
        firm_name="Olympus Peaks Financial, LLC",
    )
    assert result == {"delivery_status": "queued"}
    assert enqueued["context"] == {"purpose": "ria_claim_email_code"}
    assert callable(enqueued["send_callable"])
