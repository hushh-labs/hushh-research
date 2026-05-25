"""Redaction helpers for MCP and runtime audit logging."""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from typing import Any

REDACTED = "[REDACTED]"
MAX_LOG_STRING_LENGTH = 160

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^\+?[0-9][0-9 .()\-]{6,}$")
_TOKEN_PREFIXES = ("HCT:", "Bearer ")
_TOKEN_VALUE_RE = re.compile(r"\b(?:Bearer\s+|HCT:)[A-Za-z0-9._~+/=-]+")
_QUERY_SECRET_RE = re.compile(
    r"([?&](?:access_token|api[_-]?key|apikey|auth|client_secret|key|"
    r"private_key|refresh_token|secret|signature|token)=)([^&\s\"'<>]+)",
    flags=re.IGNORECASE,
)

_SENSITIVE_EXACT_KEYS = {
    "authorization",
    "client_id",
    "client_secret",
    "connector_key_id",
    "connector_public_key",
    "connector_private_key",
    "consent_token",
    "developer_token",
    "email",
    "encrypted_data",
    "export_key",
    "id_token",
    "phone",
    "private_key",
    "public_key",
    "refresh_token",
    "user_id",
    "wrapped_export_key",
}

_SENSITIVE_KEY_TERMS = (
    "access_token",
    "api_key",
    "auth_header",
    "bearer",
    "ciphertext",
    "connector_key",
    "credential",
    "email",
    "encrypted_data",
    "export_key",
    "firebase_uid",
    "phone",
    "private_key",
    "secret",
    "signature",
    "token",
    "user_id",
    "wrapped_key",
)


def _normalize_key(key: Any) -> str:
    with_underscores = re.sub(r"(?<!^)(?=[A-Z])", "_", str(key).strip())
    return with_underscores.lower().replace("-", "_")


def _is_sensitive_key(key: Any) -> bool:
    normalized = _normalize_key(key)
    return normalized in _SENSITIVE_EXACT_KEYS or any(
        term in normalized for term in _SENSITIVE_KEY_TERMS
    )


def _is_sensitive_string(value: str) -> bool:
    stripped = value.strip()
    if stripped.startswith(_TOKEN_PREFIXES):
        return True
    return bool(_EMAIL_RE.match(stripped) or _PHONE_RE.match(stripped))


def _redact_sensitive_substrings(value: str) -> str:
    redacted = _TOKEN_VALUE_RE.sub(REDACTED, value)
    return _QUERY_SECRET_RE.sub(lambda match: f"{match.group(1)}{REDACTED}", redacted)


def _safe_scalar(value: Any) -> Any:
    if isinstance(value, str):
        if _is_sensitive_string(value):
            return REDACTED
        value = _redact_sensitive_substrings(value)
        if len(value) > MAX_LOG_STRING_LENGTH:
            return f"{value[:MAX_LOG_STRING_LENGTH]}..."
    return value


def _is_url_like_external_object(value: Any) -> bool:
    value_type = type(value)
    module = str(getattr(value_type, "__module__", ""))
    name = str(getattr(value_type, "__name__", ""))
    return name == "URL" and module.split(".")[0] in {"httpx", "httpcore"}


def redact_log_value(value: Any) -> Any:
    """Return a log-safe copy of a value before it reaches a log sink."""
    if isinstance(value, Mapping):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            display_key = str(key)
            redacted[display_key] = REDACTED if _is_sensitive_key(key) else redact_log_value(item)
        return redacted

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        redacted_items = [redact_log_value(item) for item in value]
        return tuple(redacted_items) if isinstance(value, tuple) else redacted_items

    if _is_url_like_external_object(value):
        return _safe_scalar(str(value))

    return _safe_scalar(value)


def redact_mcp_arguments(value: Any) -> Any:
    """Return a log-safe copy of MCP tool arguments.

    The handler still receives the original arguments. This helper is only for
    audit logging, where user identifiers, consent tokens, connector keys, and
    encrypted export metadata must not be persisted in raw form.
    """
    return redact_log_value(value)


class SensitiveLogFilter(logging.Filter):
    """Redact secrets from runtime log records before handler formatting."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _redact_sensitive_substrings(record.msg)
        else:
            record.msg = redact_log_value(record.msg)
        if record.args:
            record.args = redact_log_value(record.args)
        return True


def _install_filter(target: logging.Logger | logging.Handler) -> None:
    if not any(isinstance(item, SensitiveLogFilter) for item in target.filters):
        target.addFilter(SensitiveLogFilter())


def install_sensitive_log_filter() -> None:
    """Install the runtime redaction filter on root logging handlers."""

    current_factory = logging.getLogRecordFactory()
    if not getattr(current_factory, "_hushh_sensitive_redaction_factory", False):

        def _redacting_record_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
            record = current_factory(*args, **kwargs)
            SensitiveLogFilter().filter(record)
            return record

        _redacting_record_factory._hushh_sensitive_redaction_factory = True  # type: ignore[attr-defined]
        logging.setLogRecordFactory(_redacting_record_factory)

    root_logger = logging.getLogger()
    _install_filter(root_logger)
    for handler in root_logger.handlers:
        _install_filter(handler)

    for logger_name in (
        "httpx",
        "httpcore",
        "urllib3",
        "uvicorn",
        "uvicorn.access",
        "uvicorn.error",
    ):
        logger = logging.getLogger(logger_name)
        _install_filter(logger)
        for handler in logger.handlers:
            _install_filter(handler)
