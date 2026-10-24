"""Opaque receipt checkpoints. Routing state never conveys provider authority."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.services.gmail_receipts_service import GmailApiError


def seal_state(secret: bytes, binding: list[str], value: dict[str, Any]) -> str:
    nonce = os.urandom(12)
    key = hashlib.sha256(b"receipt-continuity.v1\0" + secret).digest()
    body = AESGCM(key).encrypt(
        nonce, json.dumps(value, separators=(",", ":")).encode(), json.dumps(binding).encode()
    )
    return "grc1_" + base64.urlsafe_b64encode(nonce + body).decode().rstrip("=")


def open_state(secret: bytes, binding: list[str], value: str) -> dict[str, Any]:
    try:
        if not re.fullmatch(r"grc1_[A-Za-z0-9_-]{39,8100}", value):
            raise ValueError
        body = base64.urlsafe_b64decode(value[5:] + "=" * (-len(value[5:]) % 4))
        key = hashlib.sha256(b"receipt-continuity.v1\0" + secret).digest()
        result = json.loads(AESGCM(key).decrypt(body[:12], body[12:], json.dumps(binding).encode()))
        if not isinstance(result, dict):
            raise ValueError
        return result
    except Exception:
        raise GmailApiError(
            "Saved Mail progress needs reconciliation.",
            status_code=409,
            code="GMAIL_RECEIPT_CHECKPOINT_EXPIRED",
        ) from None


def history_changes(payload: dict[str, Any], target: str) -> list[tuple[str, bool]]:
    """A history record can hold many messages; callers page INSIDE this list."""
    records = payload.get("history", [])
    if not isinstance(records, list) or len(records) > 10:
        raise ValueError("Invalid receipt history")
    changes: dict[str, bool] = {}
    for record in records:
        if not isinstance(record, dict) or not re.fullmatch(
            r"[0-9]{1,30}", str(record.get("id", ""))
        ):
            raise ValueError("Invalid receipt history")
        if int(record["id"]) > int(target):
            continue
        for field in ("messagesAdded", "labelsAdded", "labelsRemoved", "messagesDeleted"):
            events = record.get(field, [])
            if not isinstance(events, list):
                raise ValueError("Invalid receipt history")
            for event in events:
                message = event.get("message") if isinstance(event, dict) else None
                identity = message.get("id") if isinstance(message, dict) else None
                if not isinstance(identity, str) or not re.fullmatch(
                    r"[A-Za-z0-9_-]{1,200}", identity
                ):
                    raise ValueError("Invalid receipt history")
                changes[identity] = field == "messagesDeleted"
                if len(changes) > 10000:
                    raise ValueError("Receipt history capacity exceeded")
    return list(changes.items())


def should_scan_delta(cursor: str | None, checkpoint: str | None) -> bool:
    """A bootstrap cursor wins over its preceding completed history checkpoint."""
    return cursor.startswith("grc1_") if cursor else bool(checkpoint)


async def bootstrap_window(
    get: Callable[..., Awaitable[dict[str, Any]]],
    client: httpx.AsyncClient,
    budget: list[int],
    continuation: dict[str, Any] | None,
    incremental: bool,
    window_end: int,
) -> tuple[str | None, int]:
    baseline = continuation.get("sync_baseline") if continuation else None
    if incremental and not continuation:
        profile = await get(
            client=client, path="/profile", params={"fields": "historyId"}, budget=budget
        )
        baseline = str(profile.get("historyId", ""))
        # Baseline first, then a one-second overlapping listing cutoff.
        window_end = int(datetime.now(timezone.utc).timestamp()) + 1
        if not re.fullmatch(r"[0-9]{1,30}", baseline):
            raise GmailApiError(
                "Mail progress is unavailable.",
                status_code=502,
                code="GMAIL_RECEIPT_INVALID_RESPONSE",
            )
    return baseline, window_end


def bootstrap_checkpoint(
    secret: bytes,
    binding: list[str],
    baseline: str | None,
    provider_has_more: bool,
    incremental: bool,
) -> dict[str, Any]:
    if not incremental:
        return {}
    return {
        "sync_mode": "bootstrap",
        "checkpoint": seal_state(secret, binding, {"history": baseline, "kind": "checkpoint"})
        if baseline and not provider_has_more
        else None,
    }
