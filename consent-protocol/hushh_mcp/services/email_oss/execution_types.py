# SPDX-License-Identifier: GPL-3.0-only
"""Shared validation/error contract for the GPL-derived Gmail execution port."""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

_ID = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")
_ATTACHMENT_ID = re.compile(r"[A-Za-z0-9_-]{1,4096}\Z")
_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_MAX_BODY_BYTES = 32 * 1024
_MAX_PARTS = 200
_MAX_DEPTH = 12
_HEADERS = ("Subject", "From", "To", "Cc", "Date", "Message-ID", "References", "Reply-To")
AccessCheck = Callable[[], Awaitable[None] | None]


class GmailExecutionError(RuntimeError):
    """Fixed public error; never includes a provider response, query or content."""

    def __init__(self, code: str, *, outcome_unknown: bool = False):
        super().__init__(code)
        self.code = code
        self.outcome_unknown = outcome_unknown


def _identifier(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise GmailExecutionError("invalid_argument")
    return value


def _attachment_identifier(value: Any) -> str:
    if not isinstance(value, str) or not _ATTACHMENT_ID.fullmatch(value):
        raise GmailExecutionError("invalid_argument")
    return value


def _text(value: Any, maximum: int, *, required: bool = True) -> str:
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value:
        raise GmailExecutionError("invalid_argument")
    if required and not value.strip():
        raise GmailExecutionError("invalid_argument")
    return value


def _addresses(value: Any, *, required: bool = False) -> list[str]:
    values = [value] if isinstance(value, str) else value
    if values is None and not required:
        return []
    if not isinstance(values, (list, tuple)) or len(values) > 50 or (required and not values):
        raise GmailExecutionError("invalid_argument")
    addresses = []
    for address in values:
        address = _text(address, 320)
        if (
            "\r" in address
            or "\n" in address
            or not re.fullmatch(r"[^\s@<>,]+@[^\s@<>,]+", address)
        ):
            raise GmailExecutionError("invalid_argument")
        addresses.append(address)
    return addresses


def _payload(value: Any) -> dict:
    if not isinstance(value, dict):
        raise GmailExecutionError("invalid_provider_response")
    try:
        size = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        raise GmailExecutionError("invalid_provider_response") from None
    if size > _MAX_PAYLOAD_BYTES:
        raise GmailExecutionError("response_too_large")
    return value
