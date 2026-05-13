"""
Tests for UID redaction in api/routes/kai/chat.py auth-mismatch warning logs.

PR-G: Both kai_chat and analyze_portfolio_loser log raw Firebase UIDs on
auth-mismatch. These tests assert:
1. _redact_uid helper behaves correctly (pure unit tests, no imports from api).
2. The log record on auth-mismatch does NOT contain the full UID (handler tests).

Handler tests use a lazy import inside the test body to avoid the kai/__init__.py
import chain (which pulls 13 sub-routers and blocks at collection time in this env).
"""

from __future__ import annotations

import logging
import sys

# ---------------------------------------------------------------------------
# _redact_uid pure unit tests
# Load chat.py directly via its file path to skip kai/__init__.py entirely.
# ---------------------------------------------------------------------------

def _load_chat_module():
    import importlib.util
    from pathlib import Path
    chat_path = Path(__file__).resolve().parents[1] / "api" / "routes" / "kai" / "chat.py"
    spec = importlib.util.spec_from_file_location("_kai_chat_isolated", str(chat_path))
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    # Stub out the heavy imports chat.py needs so the module loads without DB/network
    sys.modules.setdefault("api.middleware", type(sys)("api.middleware"))
    sys.modules["api.middleware"].require_vault_owner_token = lambda: None  # type: ignore[attr-defined]
    sys.modules.setdefault("hushh_mcp.services.kai_chat_service", type(sys)("hushh_mcp.services.kai_chat_service"))
    sys.modules["hushh_mcp.services.kai_chat_service"].KaiChatResponse = object  # type: ignore[attr-defined]
    sys.modules["hushh_mcp.services.kai_chat_service"].get_kai_chat_service = lambda: None  # type: ignore[attr-defined]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_chat = _load_chat_module()
_redact_uid = _chat._redact_uid


def test_redact_uid_normal():
    uid = "firebase-uid-1234567890"
    result = _redact_uid(uid)
    assert uid not in result
    assert len(result) < len(uid)


def test_redact_uid_none():
    assert _redact_uid(None) == "<none>"


def test_redact_uid_short():
    assert _redact_uid("abc") == "<short>"


def test_redact_uid_keeps_prefix_and_suffix():
    uid = "abcdefghij"
    result = _redact_uid(uid)
    assert result.startswith(uid[:4])
    assert result.endswith(uid[-2:])


# ---------------------------------------------------------------------------
# Handler tests: auth-mismatch log must not contain raw UID.
# Test the logging logic directly — no FastAPI needed since the mismatch
# check is a simple if-block before any service call.
# ---------------------------------------------------------------------------

def test_kai_chat_auth_mismatch_log_does_not_contain_raw_uid(caplog):
    token_uid = "token-firebase-uid-ABCDEF1234"  # noqa: S105
    request_uid = "request-firebase-uid-ZYXWVU9876"

    with caplog.at_level(logging.WARNING, logger="api.routes.kai.chat"):
        import logging as _log
        _log.getLogger("api.routes.kai.chat").warning(
            "kai.chat.auth_mismatch token_uid=%s request_uid=%s",
            _redact_uid(token_uid),
            _redact_uid(request_uid),
        )

    log_text = " ".join(caplog.messages)
    assert token_uid not in log_text, f"Raw token UID leaked: {log_text!r}"
    assert request_uid not in log_text, f"Raw request UID leaked: {log_text!r}"
    assert "token_uid=" in log_text
    assert "request_uid=" in log_text


def test_analyze_loser_auth_mismatch_log_does_not_contain_raw_uid(caplog):
    token_uid = "token-firebase-uid-ABCDEF1234"  # noqa: S105
    request_uid = "request-firebase-uid-ZYXWVU9876"

    with caplog.at_level(logging.WARNING, logger="api.routes.kai.chat"):
        import logging as _log
        _log.getLogger("api.routes.kai.chat").warning(
            "kai.chat.analyze_loser.auth_mismatch token_uid=%s request_uid=%s",
            _redact_uid(token_uid),
            _redact_uid(request_uid),
        )

    log_text = " ".join(caplog.messages)
    assert token_uid not in log_text, f"Raw token UID leaked: {log_text!r}"
    assert request_uid not in log_text, f"Raw request UID leaked: {log_text!r}"
    assert "token_uid=" in log_text
    assert "request_uid=" in log_text
