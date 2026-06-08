from __future__ import annotations

import json
import logging

import httpx
import pytest
from mcp.types import TextContent

import mcp_server
from mcp_modules.log_redaction import (
    REDACTED,
    SensitiveLogFilter,
    install_sensitive_log_filter,
    redact_log_value,
    redact_mcp_arguments,
)


def test_redact_mcp_arguments_hides_sensitive_tool_inputs() -> None:
    args = {
        "user_id": "owner@example.com",
        "consent_token": "HCT:raw-consent-token.signature",  # noqa: S105
        "developer_token": "dev-token-123",  # noqa: S105
        "connector_key_id": "connector-prod-key",
        "connector_public_key": "base64-public-key",
        "expected_scope": "attr.financial.*",
        "ticker": "AAPL",
        "recipientUserId": "firebase-user-123",
        "ownerEmail": "owner-alias@example.com",
        "wrapped_key_bundle": {
            "wrapped_export_key": "wrapped-secret",
            "sender_public_key": "sender-public-key",
        },
        "items": [
            {"email": "recipient@example.com"},
            {"safe_label": "portfolio import"},
        ],
    }

    redacted = redact_mcp_arguments(args)
    serialized = json.dumps(redacted, sort_keys=True)

    for raw_value in (
        "owner@example.com",
        "HCT:raw-consent-token.signature",
        "dev-token-123",
        "connector-prod-key",
        "base64-public-key",
        "firebase-user-123",
        "owner-alias@example.com",
        "wrapped-secret",
        "sender-public-key",
        "recipient@example.com",
    ):
        assert raw_value not in serialized

    assert redacted["user_id"] == REDACTED
    assert redacted["consent_token"] == REDACTED
    assert redacted["recipientUserId"] == REDACTED
    assert redacted["ownerEmail"] == REDACTED
    assert redacted["wrapped_key_bundle"] == REDACTED
    assert redacted["ticker"] == "AAPL"
    assert redacted["expected_scope"] == "attr.financial.*"
    assert redacted["items"][1]["safe_label"] == "portfolio import"


@pytest.mark.asyncio
async def test_call_tool_logs_redacted_arguments_but_passes_raw_args(monkeypatch, caplog) -> None:
    raw_user_id = "owner@example.com"
    raw_consent_token = "HCT:raw-consent-token.signature"  # noqa: S105
    received_args = {}

    async def _handler(args: dict) -> list[TextContent]:
        received_args.update(args)
        return [TextContent(type="text", text=json.dumps({"status": "ok"}))]

    monkeypatch.setitem(mcp_server.HANDLERS, "redaction_probe", _handler)
    monkeypatch.setattr(mcp_server, "is_tool_allowed", lambda _name: True)

    with caplog.at_level(logging.INFO, logger="hushh-mcp-server"):
        result = await mcp_server.call_tool(
            "redaction_probe",
            {
                "user_id": raw_user_id,
                "consent_token": raw_consent_token,
                "ticker": "HUSHH",
            },
        )

    assert json.loads(result[0].text) == {"status": "ok"}
    assert received_args["user_id"] == raw_user_id
    assert received_args["consent_token"] == raw_consent_token
    assert raw_user_id not in caplog.text
    assert raw_consent_token not in caplog.text
    assert '"ticker": "HUSHH"' in caplog.text
    assert REDACTED in caplog.text


def test_redact_log_value_hides_provider_query_credentials() -> None:
    message = (
        "HTTP Request: GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=secret-token "
        "and https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=secret-key"
    )

    redacted = redact_log_value(message)

    assert "secret-token" not in redacted
    assert "secret-key" not in redacted
    assert f"token={REDACTED}" in redacted
    assert f"apikey={REDACTED}" in redacted


def test_sensitive_log_filter_redacts_message_args() -> None:
    record = logging.LogRecord(
        name="httpx",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="url=%s token=%s",
        args=(
            "https://example.test/api?access_token=secret-access-token",
            "Bearer secret-bearer-token",
        ),
        exc_info=None,
    )

    assert SensitiveLogFilter().filter(record)
    rendered = record.getMessage()

    assert "secret-access-token" not in rendered
    assert "secret-bearer-token" not in rendered
    assert REDACTED in rendered


def test_sensitive_log_filter_preserves_format_args_after_template_redaction() -> None:
    record = logging.LogRecord(
        name="voice",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="models=%s enabled=%s timeout=%s",
        args=(["gpt-4o-mini-transcribe"], True, 20.0),
        exc_info=None,
    )

    assert SensitiveLogFilter().filter(record)

    assert "models=['gpt-4o-mini-transcribe'] enabled=True timeout=20.0" == record.getMessage()


def test_sensitive_log_record_factory_redacts_third_party_logs() -> None:
    install_sensitive_log_filter()
    record = logging.getLogRecordFactory()(
        "httpx",
        logging.INFO,
        __file__,
        1,
        "HTTP Request: GET %s",
        ("https://finnhub.io/api/v1/quote?symbol=AAPL&token=secret-provider-token",),
        None,
    )

    rendered = record.getMessage()

    assert "secret-provider-token" not in rendered
    assert f"token={REDACTED}" in rendered


def test_sensitive_log_record_factory_redacts_httpx_url_args() -> None:
    install_sensitive_log_filter()
    record = logging.getLogRecordFactory()(
        "httpx",
        logging.INFO,
        __file__,
        1,
        "HTTP Request: GET %s",
        (httpx.URL("https://finnhub.io/api/v1/quote?symbol=AAPL&token=secret-provider-token"),),
        None,
    )

    rendered = record.getMessage()

    assert "secret-provider-token" not in rendered
    assert f"token={REDACTED}" in rendered
