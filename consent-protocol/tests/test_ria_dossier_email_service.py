"""Dossier-ready mail: UAT fail-closed guard, redirection, multipart body, never-raises.

The dossier sender deliberately diverges from the shared config: off
production it fails CLOSED when the test redirect is not active, so UAT can
never mail a real adviser by omission. These tests pin that guard, the
[TEST]-prefixed redirection, the production passthrough, the HTML+plain
alternatives, and the best-effort (never-raises) queue contract.
"""

from __future__ import annotations

import base64
import types
from email import message_from_bytes, policy
from typing import Any

import pytest

import hushh_mcp.services.ria_dossier_email_service as dossier_email_module
from hushh_mcp.services.ria_dossier_email_service import (
    RIADossierEmailService,
    queue_dossier_email,
)
from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    SupportEmailSendError,
)

_TEST_UID = "user_claim_123"
_ADVISER_EMAIL = "reg@olympuspeaks.com"
_TEST_INBOX = "qa-inbox@hushh.ai"
_ORIGIN = "https://uat.hushh.ai"
_DOSSIER_URL = f"{_ORIGIN}/one/profile"

# Sentinel values only — never real credentials. The leak test asserts these
# exact strings are absent from every outbound byte.
_SENTINEL_PRIVATE_KEY = "sentinel-private-key-not-a-real-secret"
_SENTINEL_INTEL_KEY = "sentinel-intelligence-key-not-a-real-secret"


def _make_config(
    *,
    delivery_mode: str = "live",
    test_to: str | None = None,
    configured: bool = True,
) -> SupportEmailConfig:
    return SupportEmailConfig(
        service_account_info={},
        service_account_email="svc@proj.iam.gserviceaccount.com",
        private_key=_SENTINEL_PRIVATE_KEY,
        project_id="proj",
        client_id=None,
        delegated_user="one@hushh.ai",
        from_email="one@hushh.ai",
        support_to_email="one@hushh.ai",
        test_to_email=test_to,
        delivery_mode=delivery_mode,  # type: ignore[arg-type]
        configured=configured,
    )


class _FakeGmailSession:
    def __init__(self, *, status_code: int = 200, payload: dict[str, Any] | None = None):
        self.status_code = status_code
        self.payload = payload if payload is not None else {"id": "gmail-msg-1"}
        self.requests: list[dict[str, Any]] = []

    def post(self, url: str, json: dict[str, Any] | None = None, timeout: int | None = None):
        self.requests.append({"url": url, "json": json, "timeout": timeout})
        return types.SimpleNamespace(status_code=self.status_code, json=lambda: self.payload)


def _service_with(
    monkeypatch,
    cfg: SupportEmailConfig,
    *,
    session: _FakeGmailSession | None = None,
) -> tuple[RIADossierEmailService, _FakeGmailSession]:
    service = RIADossierEmailService()
    service._config = cfg
    gmail = session or _FakeGmailSession()
    monkeypatch.setattr(service, "_build_authorized_session", lambda: gmail)
    monkeypatch.setattr(dossier_email_module, "get_ria_dossier_email_service", lambda: service)
    return service, gmail


class _Queue:
    def __init__(self):
        self.jobs: list[dict[str, Any]] = []

    async def enqueue(self, **kwargs):
        self.jobs.append(kwargs)
        return {"accepted": True, "delivery_status": "queued"}


def _install_queue(monkeypatch) -> _Queue:
    queue = _Queue()
    monkeypatch.setattr(dossier_email_module, "get_email_delivery_queue_service", lambda: queue)
    return queue


def _sent_message(gmail: _FakeGmailSession):
    raw = gmail.requests[0]["json"]["raw"]
    return message_from_bytes(base64.urlsafe_b64decode(raw), policy=policy.default)


# ---------------------------------------------------------------------------
# UAT fail-closed guard
# ---------------------------------------------------------------------------


async def test_uat_blocks_when_test_redirect_unset(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    _service_with(monkeypatch, _make_config(delivery_mode="live", test_to=None))
    queue = _install_queue(monkeypatch)

    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )

    assert result["delivery_status"] == "blocked_test_unset"
    assert result["intended_recipient"] == _ADVISER_EMAIL
    assert result["actual_recipient"] == ""
    assert queue.jobs == []


async def test_uat_blocks_when_mode_is_test_but_test_to_missing(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    _service_with(monkeypatch, _make_config(delivery_mode="test", test_to=None))
    queue = _install_queue(monkeypatch)

    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )

    assert result["delivery_status"] == "blocked_test_unset"
    assert queue.jobs == []


async def test_unset_environment_also_fails_closed(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    _service_with(monkeypatch, _make_config(delivery_mode="live", test_to=None))
    queue = _install_queue(monkeypatch)

    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )

    assert result["delivery_status"] == "blocked_test_unset"
    assert queue.jobs == []


async def test_uat_with_redirect_queues_to_the_test_inbox(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    _service_with(monkeypatch, _make_config(delivery_mode="test", test_to=_TEST_INBOX))
    queue = _install_queue(monkeypatch)

    async def _on_success(_result):  # pragma: no cover - identity check only
        pass

    async def _on_failure(_exc):  # pragma: no cover - identity check only
        pass

    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
        on_success=_on_success,
        on_failure=_on_failure,
    )

    assert result == {
        "delivery_status": "queued",
        "intended_recipient": _ADVISER_EMAIL,
        "actual_recipient": _TEST_INBOX,
        "delivery_mode": "test",
    }
    assert len(queue.jobs) == 1
    job = queue.jobs[0]
    assert job["kind"] == "invite_email"
    assert job["context"] == {"purpose": "ria_dossier_email", "user_id": _TEST_UID}
    assert job["on_success"] is _on_success
    assert job["on_failure"] is _on_failure


async def test_uat_send_redirects_and_prefixes_the_subject(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    service, gmail = _service_with(
        monkeypatch, _make_config(delivery_mode="test", test_to=_TEST_INBOX)
    )
    queue = _install_queue(monkeypatch)

    await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )
    # Run the queued job the way the delivery worker would.
    delivery = queue.jobs[0]["send_callable"]()

    assert delivery.accepted is True
    assert delivery.message_id == "gmail-msg-1"
    assert delivery.recipient == _TEST_INBOX
    assert delivery.intended_recipient == _ADVISER_EMAIL
    message = _sent_message(gmail)
    assert message["To"] == _TEST_INBOX
    assert message["Subject"] == "[TEST] Your Hushh dossier"
    plain = message.get_body(preferencelist=("plain",)).get_content()
    assert f"Actual recipient: {_TEST_INBOX}" in plain
    assert f"Intended recipient: {_ADVISER_EMAIL}" in plain


# ---------------------------------------------------------------------------
# Production passthrough
# ---------------------------------------------------------------------------


async def test_production_sends_to_the_real_recipient(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    service, gmail = _service_with(monkeypatch, _make_config(delivery_mode="live", test_to=None))
    queue = _install_queue(monkeypatch)

    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )

    assert result == {
        "delivery_status": "queued",
        "intended_recipient": _ADVISER_EMAIL,
        "actual_recipient": _ADVISER_EMAIL,
        "delivery_mode": "live",
    }
    delivery = queue.jobs[0]["send_callable"]()
    assert delivery.recipient == _ADVISER_EMAIL
    message = _sent_message(gmail)
    assert message["To"] == _ADVISER_EMAIL
    assert message["Subject"] == "Your Hushh dossier"
    plain = message.get_body(preferencelist=("plain",)).get_content()
    assert "Actual recipient:" not in plain


# ---------------------------------------------------------------------------
# Message body: HTML + plain alternatives, no secret leakage
# ---------------------------------------------------------------------------


def test_message_carries_plain_and_html_alternatives(monkeypatch):
    service, gmail = _service_with(
        monkeypatch, _make_config(delivery_mode="test", test_to=_TEST_INBOX)
    )
    service.send_dossier_ready(
        to_email=_ADVISER_EMAIL, first_name="Reginald", app_frontend_origin=_ORIGIN
    )

    message = _sent_message(gmail)
    parts = {
        part.get_content_type(): part.get_content()
        for part in message.walk()
        if part.get_content_type() in {"text/plain", "text/html"}
    }
    assert set(parts) == {"text/plain", "text/html"}

    plain = parts["text/plain"]
    assert plain.startswith("Hi Reginald,")
    assert "Your dossier is ready — built from your SEC record." in plain
    assert f"Open it: {_DOSSIER_URL}" in plain
    assert "Sent once, because you claimed your profile." in plain

    html_body = parts["text/html"]
    assert "Your dossier is ready" in html_body
    assert "Built from your SEC record after you claimed your adviser profile." in html_body
    assert f'href="{_DOSSIER_URL}"' in html_body
    assert "Open your dossier" in html_body
    assert "Sent once, because you claimed your profile." in html_body


def test_no_secret_or_env_values_leak_into_the_message(monkeypatch):
    monkeypatch.setenv("INTELLIGENCE_API_KEY", _SENTINEL_INTEL_KEY)
    monkeypatch.setenv("INTELLIGENCE_API_BASE_URL", "https://sentinel-intel.example")
    service, gmail = _service_with(
        monkeypatch, _make_config(delivery_mode="test", test_to=_TEST_INBOX)
    )
    delivery = service.send_dossier_ready(
        to_email=_ADVISER_EMAIL, first_name="Reginald", app_frontend_origin=_ORIGIN
    )

    raw_bytes = base64.urlsafe_b64decode(gmail.requests[0]["json"]["raw"])
    for leaked in (_SENTINEL_PRIVATE_KEY, _SENTINEL_INTEL_KEY, "sentinel-intel.example"):
        assert leaked.encode("utf-8") not in raw_bytes
        assert leaked not in repr(delivery)


def test_missing_recipient_raises_send_error(monkeypatch):
    service, _gmail = _service_with(
        monkeypatch, _make_config(delivery_mode="test", test_to=_TEST_INBOX)
    )
    with pytest.raises(SupportEmailSendError):
        service.send_dossier_ready(to_email="   ", app_frontend_origin=_ORIGIN)


# ---------------------------------------------------------------------------
# Best-effort contract: queue_dossier_email never raises
# ---------------------------------------------------------------------------


async def test_queue_reports_failed_when_enqueue_raises(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    _service_with(monkeypatch, _make_config(delivery_mode="live", test_to=None))

    class _BrokenQueue:
        async def enqueue(self, **_kwargs):
            raise RuntimeError("queue unavailable")

    monkeypatch.setattr(
        dossier_email_module, "get_email_delivery_queue_service", lambda: _BrokenQueue()
    )
    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )
    assert result["delivery_status"] == "failed"
    assert result["reason"] == "enqueue_failed"


async def test_queue_reports_failed_when_unconfigured(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    _service_with(monkeypatch, _make_config(delivery_mode="live", test_to=None, configured=False))
    queue = _install_queue(monkeypatch)

    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )
    assert result == {
        "delivery_status": "failed",
        "intended_recipient": _ADVISER_EMAIL,
        "actual_recipient": "",
        "delivery_mode": "live",
        "reason": "not_configured",
    }
    assert queue.jobs == []


async def test_queue_reports_failed_on_missing_recipient(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    _service_with(monkeypatch, _make_config(delivery_mode="live", test_to=None))
    queue = _install_queue(monkeypatch)

    result = await queue_dossier_email(
        user_id=_TEST_UID, to_email="   ", first_name=None, app_frontend_origin=_ORIGIN
    )
    assert result["delivery_status"] == "failed"
    assert result["reason"] == "missing_recipient"
    assert queue.jobs == []


async def test_queue_never_raises_even_when_config_loading_explodes(monkeypatch):
    def _broken_service():
        raise RuntimeError("config exploded")

    monkeypatch.setattr(dossier_email_module, "get_ria_dossier_email_service", _broken_service)
    result = await queue_dossier_email(
        user_id=_TEST_UID,
        to_email=_ADVISER_EMAIL,
        first_name="Reginald",
        app_frontend_origin=_ORIGIN,
    )
    assert result["delivery_status"] == "failed"
    assert result["reason"] == "unexpected_error"
    assert result["intended_recipient"] == _ADVISER_EMAIL
