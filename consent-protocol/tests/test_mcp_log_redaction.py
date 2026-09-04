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
        "user_identifier": "owner-alias@example.com",
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
    assert redacted["user_identifier"] == REDACTED
    assert redacted["consent_token"] == REDACTED
    assert redacted["recipientUserId"] == REDACTED
    assert redacted["ownerEmail"] == REDACTED
    assert redacted["wrapped_key_bundle"] == REDACTED
    assert redacted["ticker"] == "AAPL"
    assert redacted["expected_scope"] == "attr.financial.*"
    assert redacted["items"][1]["safe_label"] == "portfolio import"


@pytest.mark.asyncio
async def test_call_tool_does_not_log_arguments_but_passes_raw_args(monkeypatch, caplog) -> None:
    raw_user_id = "owner@example.com"
    raw_consent_token = "HCT:raw-consent-token.signature"  # noqa: S105
    received_args = {}

    async def _handler(args: dict) -> tuple[list[TextContent], dict]:
        received_args.update(args)
        payload = {"status": "ok"}
        return [TextContent(type="text", text=json.dumps(payload))], payload

    monkeypatch.setitem(mcp_server.HANDLERS, "redaction_probe", _handler)
    monkeypatch.setitem(
        mcp_server._PRIVATE_INPUT_SCHEMAS,
        "redaction_probe",
        {"type": "object", "additionalProperties": True},
    )
    monkeypatch.setattr(mcp_server, "is_tool_allowed", lambda _name: True)
    monkeypatch.setattr(mcp_server, "validate_public_tool_input", lambda _name, _args: True)
    monkeypatch.setattr(mcp_server, "validate_public_tool_output", lambda _name, _value: True)

    with caplog.at_level(logging.INFO, logger="hushh-mcp-server"):
        result = await mcp_server.call_tool(
            "redaction_probe",
            {
                "user_id": raw_user_id,
                "consent_token": raw_consent_token,
                "ticker": "HUSHH",
            },
        )

    assert json.loads(result[0][0].text) == {"status": "ok"}
    assert result[1] == {"status": "ok"}
    assert received_args["user_id"] == raw_user_id
    assert received_args["consent_token"] == raw_consent_token
    assert raw_user_id not in caplog.text
    assert raw_consent_token not in caplog.text
    assert "HUSHH" not in caplog.text
    assert "Arguments" not in caplog.text


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


# ---------------------------------------------------------------------------
# SQLAlchemy bound parameters
# ---------------------------------------------------------------------------

# ``StatementError.__str__`` appends the statement *and every bound value*
# unless the engine sets ``hide_parameters=True``; the repo sets it nowhere.
# ``db_client.execute_raw`` then does ``logger.error(f"Raw SQL error: {e}")``,
# so without this rule every DBAPI fault reprints the row it was writing.
SQLALCHEMY_ERROR = (
    '(psycopg2.errors.NotNullViolation) null value in column "user_id"\n'
    "[SQL: INSERT INTO one_wallet_cards (user_id, card_payload) "
    "VALUES (%(user_id)s, %(card_payload)s)]\n"
    "[parameters: {'user_id': 'user_123', 'card_payload': "
    '\'{"full_name": "Ada Lovelace", "email": "ada@example.com"}\'}]\n'
    "(Background on this error at: https://sqlalche.me/e/20/gkpj)"
)


def _emit(message: str) -> str:
    install_sensitive_log_filter()
    record = logging.getLogRecordFactory()(
        "db.db_client", logging.ERROR, __file__, 1, message, None, None
    )
    return record.getMessage()


def test_bound_sql_parameters_are_redacted_from_a_log_message() -> None:
    rendered = _emit(f"Raw SQL error: {SQLALCHEMY_ERROR}")

    assert "Ada Lovelace" not in rendered
    assert "ada@example.com" not in rendered
    assert "user_123" not in rendered
    assert f"[parameters: {REDACTED}]" in rendered


def test_the_statement_and_the_driver_message_survive_redaction() -> None:
    """Stripping the whole error would make production faults undiagnosable.
    The statement text and the doc link carry no values, so they are kept."""
    rendered = _emit(f"Raw SQL error: {SQLALCHEMY_ERROR}")

    assert "NotNullViolation" in rendered
    assert "INSERT INTO one_wallet_cards" in rendered
    assert "https://sqlalche.me/e/20/gkpj" in rendered


def test_a_bound_value_containing_a_bracket_cannot_leak_a_fragment() -> None:
    """Bracket-balancing would end the scan at the value's own ``]`` and print
    the rest, so redaction deliberately runs to the background-link suffix."""
    hostile = (
        "[SQL: UPDATE one_wallet_cards SET card_payload = %(card_payload)s]\n"
        '[parameters: {\'card_payload\': \'{"summary": "a]b", '
        '"full_name": "Ada Lovelace"}\'}]\n'
        "(Background on this error at: https://sqlalche.me/e/20/gkpj)"
    )

    rendered = _emit(hostile)

    assert "Ada Lovelace" not in rendered
    assert "a]b" not in rendered
    assert "https://sqlalche.me/e/20/gkpj" in rendered


def test_redaction_runs_to_the_end_when_there_is_no_background_suffix() -> None:
    rendered = _emit("Raw SQL error: [parameters: {'email': 'ada@example.com'}]")

    assert "ada@example.com" not in rendered
    assert rendered.endswith(f"[parameters: {REDACTED}]")


def test_an_exception_passed_as_a_log_argument_is_redacted() -> None:
    """``logger.warning("... %s", exc)`` keeps the exception *object* in
    ``record.args``; it is only stringified by the handler, which runs after
    the filter. Rendering it inside the filter is what closes that bypass
    (``db_client`` logs a connection failure exactly this way)."""
    install_sensitive_log_filter()
    record = logging.getLogRecordFactory()(
        "db.db_client",
        logging.WARNING,
        __file__,
        1,
        "Database connection failed: %s",
        (RuntimeError(SQLALCHEMY_ERROR),),
        None,
    )

    rendered = record.getMessage()

    assert "Ada Lovelace" not in rendered
    assert "ada@example.com" not in rendered
    assert f"[parameters: {REDACTED}]" in rendered


def test_an_ordinary_log_line_is_left_alone() -> None:
    """The rule must be inert on everything that is not a parameter blob."""
    message = "wallet_card.published serial=6f2f0e6a status=active"

    assert _emit(message) == message


def test_the_filter_is_installed_by_the_api_server() -> None:
    """The redaction only helps if it is actually wired into the API process
    that serves the Wallet routes, not just the MCP server."""
    from pathlib import Path

    server = (Path(__file__).resolve().parents[1] / "server.py").read_text(encoding="utf-8")

    assert "install_sensitive_log_filter()" in server
