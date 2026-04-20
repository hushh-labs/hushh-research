"""Tests for the askkai@hushh.ai email agent service and route.

Covers:
- Inbound email parsing (SendGrid format, edge cases)
- Quoted reply stripping
- Agent prompt construction
- Route payload handling (JSON and form-data)
- Webhook signature verification
"""

from __future__ import annotations

import hashlib
import hmac
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services.email_agent_service import (
    ParsedInboundEmail,
    _build_agent_prompt,
    _extract_display_name,
    _extract_email_address,
    _fallback_response,
    _strip_quoted_reply,
    parse_sendgrid_inbound,
)

# ==========================================================================
# Email address extraction
# ==========================================================================


class TestExtractEmailAddress:
    def test_bare_email(self):
        assert _extract_email_address("alice@example.com") == "alice@example.com"

    def test_display_name_format(self):
        assert _extract_email_address("Alice Smith <alice@example.com>") == "alice@example.com"

    def test_uppercase_normalized(self):
        assert _extract_email_address("BOB@EXAMPLE.COM") == "bob@example.com"

    def test_none_returns_none(self):
        assert _extract_email_address(None) is None

    def test_empty_returns_none(self):
        assert _extract_email_address("") is None

    def test_no_at_sign(self):
        assert _extract_email_address("not-an-email") is None


class TestExtractDisplayName:
    def test_with_angle_brackets(self):
        assert _extract_display_name("Alice Smith <alice@example.com>") == "Alice Smith"

    def test_quoted_name(self):
        assert _extract_display_name('"Bob Jones" <bob@example.com>') == "Bob Jones"

    def test_bare_email_returns_none(self):
        assert _extract_display_name("alice@example.com") is None

    def test_none_returns_none(self):
        assert _extract_display_name(None) is None


# ==========================================================================
# Quoted reply stripping
# ==========================================================================


class TestStripQuotedReply:
    def test_removes_quoted_lines(self):
        text = "Hello Kai\n\n> Previous message\n> More quoted"
        assert _strip_quoted_reply(text) == "Hello Kai"

    def test_stops_at_on_wrote_marker(self):
        text = "My question is about KYC.\n\nOn Mon, Apr 14, 2025 at 10:00 AM Support wrote:\n> old reply"
        result = _strip_quoted_reply(text)
        assert "My question is about KYC." in result
        assert "wrote:" not in result

    def test_stops_at_signature_dash(self):
        text = "Hello\n--\nJohn Doe\nCEO"
        assert _strip_quoted_reply(text) == "Hello"

    def test_preserves_clean_text(self):
        text = "Just a simple message with no replies."
        assert _strip_quoted_reply(text) == text

    def test_stops_at_forwarded_message(self):
        text = "Check this\n---------- Forwarded message ----------\nOriginal"
        assert _strip_quoted_reply(text) == "Check this"


# ==========================================================================
# SendGrid inbound parsing
# ==========================================================================


class TestParseSendgridInbound:
    def test_basic_payload(self):
        payload = {
            "from": "Alice <alice@example.com>",
            "to": "askkai@hushh.ai",
            "subject": "KYC question",
            "text": "What documents do I need?",
        }
        parsed = parse_sendgrid_inbound(payload)
        assert parsed.sender_email == "alice@example.com"
        assert parsed.sender_name == "Alice"
        assert parsed.recipient_email == "askkai@hushh.ai"
        assert parsed.subject == "KYC question"
        assert parsed.body_text == "What documents do I need?"

    def test_html_fallback(self):
        payload = {
            "from": "bob@example.com",
            "subject": "Hello",
            "html": "<p>Hi there!</p>",
        }
        parsed = parse_sendgrid_inbound(payload)
        assert "Hi there!" in parsed.body_text

    def test_missing_sender_raises(self):
        payload = {"subject": "No sender", "text": "Body"}
        with pytest.raises(ValueError, match="sender"):
            parse_sendgrid_inbound(payload)

    def test_empty_body_raises(self):
        payload = {"from": "alice@example.com", "subject": "Empty", "text": "", "html": ""}
        with pytest.raises(ValueError, match="body"):
            parse_sendgrid_inbound(payload)

    def test_no_subject_defaults(self):
        payload = {"from": "alice@example.com", "text": "Body text"}
        parsed = parse_sendgrid_inbound(payload)
        assert parsed.subject == "(no subject)"

    def test_user_message_strips_quotes(self):
        payload = {
            "from": "alice@example.com",
            "subject": "Re: KYC",
            "text": "My follow-up question\n\n> Previous message from Kai",
        }
        parsed = parse_sendgrid_inbound(payload)
        assert parsed.user_message == "My follow-up question"


# ==========================================================================
# Agent prompt building
# ==========================================================================


class TestBuildAgentPrompt:
    def test_includes_sender_and_subject(self):
        email = ParsedInboundEmail(
            sender_email="alice@example.com",
            sender_name="Alice",
            recipient_email="askkai@hushh.ai",
            subject="My KYC question",
            body_text="What do I need to get started?",
            raw_body="What do I need to get started?",
        )
        prompt = _build_agent_prompt(email)
        assert "alice@example.com" in prompt
        assert "My KYC question" in prompt
        assert "What do I need to get started?" in prompt


# ==========================================================================
# Fallback response
# ==========================================================================


class TestFallbackResponse:
    def test_contains_hushh_url(self):
        assert "hushh.ai" in _fallback_response()


# ==========================================================================
# Route-level tests (using FastAPI TestClient)
# ==========================================================================


class TestInboundEmailRoute:
    """Test the /api/email/inbound endpoint logic without a running server."""

    @pytest.fixture
    def client(self):
        """Build a TestClient around the email_agent router only."""
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from api.routes.email_agent import router

        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def test_health(self, client):
        resp = client.get("/api/email/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    @patch("api.routes.email_agent.generate_agent_response", return_value="Kai says hi")
    @patch("api.routes.email_agent.get_email_delivery_queue_service")
    def test_inbound_json_accepted(self, mock_queue, mock_agent, client):
        async def _mock_enqueue(**kwargs):
            return {"delivery_status": "queued", "job_id": "job_abc"}

        mock_queue.return_value = MagicMock()
        mock_queue.return_value.enqueue = _mock_enqueue

        resp = client.post(
            "/api/email/inbound",
            json={
                "from": "alice@example.com",
                "to": "askkai@hushh.ai",
                "subject": "KYC help",
                "text": "I want to onboard.",
            },
        )
        assert resp.status_code == 202
        body = resp.json()
        assert body["accepted"] is True
        assert body["sender"] == "alice@example.com"
        assert body["reply_queued"] is True

    def test_inbound_missing_sender_returns_422(self, client):
        resp = client.post(
            "/api/email/inbound",
            json={"subject": "No sender", "text": "Body"},
        )
        assert resp.status_code == 422

    def test_inbound_unsupported_content_type(self, client):
        resp = client.post(
            "/api/email/inbound",
            content=b"plain text",
            headers={"content-type": "text/plain"},
        )
        assert resp.status_code == 415


# ==========================================================================
# Webhook signature verification
# ==========================================================================


class TestWebhookSignatureVerification:
    def test_no_secret_configured_passes(self, monkeypatch):
        monkeypatch.delenv("SENDGRID_WEBHOOK_SECRET", raising=False)
        from api.routes.email_agent import _verify_sendgrid_signature

        assert _verify_sendgrid_signature(b"body", None) is True

    def test_valid_signature_passes(self, monkeypatch):
        secret = "test-webhook-secret"  # noqa: S105
        monkeypatch.setenv("SENDGRID_WEBHOOK_SECRET", secret)
        body = b'{"from":"a@b.com"}'
        sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

        from api.routes.email_agent import _verify_sendgrid_signature

        assert _verify_sendgrid_signature(body, sig) is True

    def test_invalid_signature_fails(self, monkeypatch):
        monkeypatch.setenv("SENDGRID_WEBHOOK_SECRET", "real-secret")
        from api.routes.email_agent import _verify_sendgrid_signature

        assert _verify_sendgrid_signature(b"body", "wrong-sig") is False
