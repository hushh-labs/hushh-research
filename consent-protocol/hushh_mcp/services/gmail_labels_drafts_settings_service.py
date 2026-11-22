"""Direct Gmail REST API v1 operon for Labels, Drafts, Untrash & Settings.

Reuses ``GmailReceiptsService`` for owner credential custody, token refresh, and
scope verification; never duplicates OAuth or stores plaintext mailbox content.
- Labels CRUD & Untrash: ``gmail.readonly`` (reads) / ``gmail.modify`` (writes)
- Drafts CRUD: ``gmail.readonly`` (reads) / ``gmail.compose`` (writes)
- Filters, Signatures, Vacation & Forwarding status: ``gmail.settings.basic``
  (filter preview runs over ``gmail.readonly``)
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
from collections.abc import Sequence
from email.message import EmailMessage
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.gmail_receipt_scanner import format_local_timestamp
from hushh_mcp.services.gmail_receipts_service import (
    _GMAIL_COMPOSE_SCOPE,
    _GMAIL_MODIFY_SCOPE,
    _GMAIL_READONLY_SCOPE,
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
)

logger = logging.getLogger(__name__)

_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_GMAIL_SETTINGS_BASIC_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic"
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_EMAIL_RE = re.compile(r"^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$")

# Official Gmail REST API v1 allowed label color pairs (backgroundColor, textColor).
GMAIL_LABEL_COLORS: dict[str, dict[str, str]] = {
    "blue": {"backgroundColor": "#4a86e8", "textColor": "#ffffff"},
    "light_blue": {"backgroundColor": "#c9daf8", "textColor": "#0d3472"},
    "navy": {"backgroundColor": "#1c4587", "textColor": "#ffffff"},
    "green": {"backgroundColor": "#16a766", "textColor": "#ffffff"},
    "light_green": {"backgroundColor": "#b9e4d0", "textColor": "#0b4f30"},
    "red": {"backgroundColor": "#cc3a21", "textColor": "#ffffff"},
    "light_red": {"backgroundColor": "#f4c8af", "textColor": "#7a2e0b"},
    "orange": {"backgroundColor": "#ff7537", "textColor": "#ffffff"},
    "yellow": {"backgroundColor": "#fad165", "textColor": "#594c05"},
    "purple": {"backgroundColor": "#a479e2", "textColor": "#ffffff"},
    "pink": {"backgroundColor": "#f691b3", "textColor": "#ffffff"},
    "teal": {"backgroundColor": "#2da2bb", "textColor": "#ffffff"},
    "gray": {"backgroundColor": "#999999", "textColor": "#ffffff"},
    "grey": {"backgroundColor": "#999999", "textColor": "#ffffff"},
    "black": {"backgroundColor": "#000000", "textColor": "#ffffff"},
}

_LABEL_LIST_VISIBILITY = {
    "show": "labelShow",
    "labelshow": "labelShow",
    "unread": "labelShowIfUnread",
    "show_if_unread": "labelShowIfUnread",
    "labelshowifunread": "labelShowIfUnread",
    "hide": "labelHide",
    "labelhide": "labelHide",
}

_MESSAGE_LIST_VISIBILITY = {
    "show": "show",
    "hide": "hide",
}


def _err(code: str, message: str, status_code: int = 409) -> GmailApiError:
    return GmailApiError(message, status_code=status_code, code=code)


def _resolve_color(color_name: str | None) -> dict[str, str] | None:
    if not color_name or not str(color_name).strip():
        return None
    key = str(color_name).strip().lower().replace("-", "_").replace(" ", "_")
    return GMAIL_LABEL_COLORS.get(key)


def _build_raw_rfc822(
    *,
    to: str = "",
    subject: str = "",
    body: str = "",
    cc: str = "",
    bcc: str = "",
) -> str:
    msg = EmailMessage()
    if to.strip():
        msg["To"] = to.strip()
    if cc.strip():
        msg["Cc"] = cc.strip()
    if bcc.strip():
        msg["Bcc"] = bcc.strip()
    msg["Subject"] = subject.replace("\r", " ").replace("\n", " ").strip()
    msg.set_content(body or "")
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")


def _extract_draft_headers(message: dict[str, Any]) -> dict[str, str]:
    payload = message.get("payload") if isinstance(message, dict) else None
    headers = payload.get("headers") if isinstance(payload, dict) else None
    out: dict[str, str] = {}
    if isinstance(headers, list):
        for h in headers:
            if isinstance(h, dict) and isinstance(h.get("name"), str):
                out[h["name"].lower()] = str(h.get("value") or "")
    return out


class GmailLabelsDraftsSettingsService:
    """Owner-bound direct Gmail REST client for Labels, Drafts, Untrash & Settings."""

    def __init__(
        self,
        *,
        gmail: GmailReceiptsService | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._gmail = gmail or get_gmail_receipts_service()
        self._transport = transport

    async def _token_for_scope(self, *, user_id: str, required_scope: str) -> str:
        row = await asyncio.to_thread(self._gmail._fetch_connection_row, user_id=user_id)
        if not row or self._gmail._derive_connection_state(row) != "connected":
            raise _err("GMAIL_NOT_CONNECTED", "Connect Gmail in Connections first.")
        scopes = self._gmail._granted_scopes(row)
        if required_scope not in scopes:
            if required_scope == _GMAIL_MODIFY_SCOPE:
                raise _err(
                    "GMAIL_MODIFY_PERMISSION_REQUIRED",
                    "Allow Gmail organize permission before changing labels or mailbox items.",
                )
            if required_scope == _GMAIL_COMPOSE_SCOPE:
                raise _err(
                    "GMAIL_COMPOSE_PERMISSION_REQUIRED",
                    "Allow Gmail drafts permission before creating or editing drafts.",
                )
            if required_scope == _GMAIL_SETTINGS_BASIC_SCOPE:
                raise _err(
                    "GMAIL_SETTINGS_PERMISSION_REQUIRED",
                    "Allow Gmail settings permission before managing filters, signatures, or vacation responder.",
                )
            raise _err("GMAIL_REAUTH_REQUIRED", "Reconnect Gmail in Connections to continue.")
        token, refreshed_row = await self._gmail._ensure_access_token(user_id=user_id)
        if required_scope not in self._gmail._granted_scopes(refreshed_row):
            raise _err("GMAIL_REAUTH_REQUIRED", "Reconnect Gmail in Connections to continue.")
        return token

    async def _request(
        self,
        *,
        user_id: str,
        required_scope: str,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        timeout: float = 15.0,
    ) -> Any:
        token = await self._token_for_scope(user_id=user_id, required_scope=required_scope)
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(
            transport=self._transport, timeout=timeout, follow_redirects=False
        ) as client:
            with suppress_instrumentation():
                resp = await client.request(
                    method,
                    f"{_BASE}{path}",
                    headers=headers,
                    params=params,
                    json=json_body,
                )
        if resp.status_code == 204 or not resp.content:
            return {}
        if resp.status_code == 401:
            raise _err("GMAIL_REAUTH_REQUIRED", "Reconnect Gmail in Connections to continue.", 401)
        if resp.status_code == 403:
            if required_scope == _GMAIL_SETTINGS_BASIC_SCOPE:
                raise _err(
                    "GMAIL_SETTINGS_PERMISSION_REQUIRED",
                    "Allow Gmail settings permission before managing filters, signatures, or vacation responder.",
                    403,
                )
            raise _err(
                "GMAIL_PERMISSION_DENIED",
                "Gmail refused this action for the current permissions.",
                403,
            )
        if resp.status_code == 404:
            raise _err("GMAIL_NOT_FOUND", "That Gmail item could not be found.", 404)
        if resp.status_code == 409:
            raise _err("GMAIL_CONFLICT", "A Gmail item with that name already exists.", 409)
        if resp.status_code >= 400:
            raise _err(
                "GMAIL_API_ERROR",
                f"Gmail returned HTTP {resp.status_code} for this request.",
                resp.status_code,
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise _err(
                "GMAIL_INVALID_RESPONSE", "Gmail returned an unreadable response.", 502
            ) from exc

    # ------------------------------------------------------------------
    # Labels CRUD (gmail.readonly / gmail.modify)
    # ------------------------------------------------------------------

    async def list_labels(
        self,
        *,
        user_id: str,
        filter_type: str = "all",
        include_counts: bool = True,
    ) -> dict[str, Any]:
        listing = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_READONLY_SCOPE,
            method="GET",
            path="/labels",
        )
        raw_labels = listing.get("labels") or []
        wanted_type = str(filter_type or "all").strip().lower()
        filtered = [
            row
            for row in raw_labels
            if isinstance(row, dict)
            and (
                wanted_type == "all"
                or (wanted_type in {"user", "custom"} and row.get("type") == "user")
                or (wanted_type == "system" and row.get("type") == "system")
            )
        ]

        # Enrich up to 35 labels with exact message/unread counts & colors concurrently
        details_by_id: dict[str, dict[str, Any]] = {}
        if include_counts and filtered:
            token = await self._token_for_scope(
                user_id=user_id, required_scope=_GMAIL_READONLY_SCOPE
            )
            headers = {"Authorization": f"Bearer {token}"}
            sem = asyncio.Semaphore(10)
            to_fetch = [
                str(r["id"])
                for r in filtered
                if isinstance(r.get("id"), str) and _SAFE_ID_RE.fullmatch(r["id"])
            ][:35]
            async with httpx.AsyncClient(
                transport=self._transport, timeout=12.0, follow_redirects=False
            ) as client:

                async def fetch_one(lid: str) -> None:
                    async with sem:
                        try:
                            with suppress_instrumentation():
                                r = await client.get(f"{_BASE}/labels/{lid}", headers=headers)
                            if r.status_code == 200:
                                details_by_id[lid] = r.json()
                        except Exception:  # noqa: BLE001
                            return

                await asyncio.gather(*(fetch_one(lid) for lid in to_fetch))

        labels: list[dict[str, Any]] = []
        for row in filtered:
            lid = str(row.get("id") or "")
            merged = details_by_id.get(lid, row)
            labels.append(
                {
                    "id": lid,
                    "name": str(merged.get("name") or ""),
                    "type": str(merged.get("type") or "user"),
                    "color": merged.get("color"),
                    "label_list_visibility": merged.get("labelListVisibility"),
                    "message_list_visibility": merged.get("messageListVisibility"),
                    "messages_total": merged.get("messagesTotal"),
                    "messages_unread": merged.get("messagesUnread"),
                    "threads_total": merged.get("threadsTotal"),
                }
            )
        labels.sort(key=lambda item: (0 if item["type"] == "user" else 1, item["name"].casefold()))
        return {
            "status": "ok",
            "count": len(labels),
            "filter_type": wanted_type,
            "labels": labels,
        }

    async def _find_user_label(self, *, user_id: str, name_or_id: str) -> dict[str, Any] | None:
        listing = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_READONLY_SCOPE,
            method="GET",
            path="/labels",
        )
        needle = name_or_id.strip()
        needle_cf = needle.casefold()
        for row in listing.get("labels") or []:
            if not isinstance(row, dict):
                continue
            if (
                str(row.get("id") or "") == needle
                or str(row.get("name") or "").casefold() == needle_cf
            ):
                return row
        return None

    async def create_label(
        self,
        *,
        user_id: str,
        name: str,
        color_name: str | None = None,
        label_list_visibility: str | None = None,
        message_list_visibility: str | None = None,
    ) -> dict[str, Any]:
        cleaned = str(name or "").strip()
        if not cleaned or len(cleaned) > 225 or any(ord(c) < 32 for c in cleaned):
            raise _err("GMAIL_INVALID_LABEL", "Provide a valid label name.", 422)
        existing = await self._find_user_label(user_id=user_id, name_or_id=cleaned)
        if existing is not None:
            return {
                "status": "already_exists",
                "label": {
                    "id": existing.get("id"),
                    "name": existing.get("name"),
                    "type": existing.get("type"),
                },
            }
        payload: dict[str, Any] = {
            "name": cleaned,
            "labelListVisibility": _LABEL_LIST_VISIBILITY.get(
                str(label_list_visibility or "show").strip().lower(), "labelShow"
            ),
            "messageListVisibility": _MESSAGE_LIST_VISIBILITY.get(
                str(message_list_visibility or "show").strip().lower(), "show"
            ),
        }
        color = _resolve_color(color_name)
        if color is not None:
            payload["color"] = color
        created = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_MODIFY_SCOPE,
            method="POST",
            path="/labels",
            json_body=payload,
        )
        return {
            "status": "created",
            "label": {
                "id": created.get("id"),
                "name": created.get("name"),
                "type": created.get("type", "user"),
                "color": created.get("color"),
                "label_list_visibility": created.get("labelListVisibility"),
                "message_list_visibility": created.get("messageListVisibility"),
            },
        }

    async def update_label(
        self,
        *,
        user_id: str,
        current_name_or_id: str,
        new_name: str | None = None,
        color_name: str | None = None,
        label_list_visibility: str | None = None,
        message_list_visibility: str | None = None,
    ) -> dict[str, Any]:
        target = await self._find_user_label(user_id=user_id, name_or_id=current_name_or_id)
        if target is None:
            raise _err("GMAIL_NOT_FOUND", f"Label '{current_name_or_id}' was not found.", 404)
        if target.get("type") == "system":
            raise _err(
                "GMAIL_SYSTEM_LABEL_IMMUTABLE",
                "Gmail system labels cannot be renamed or edited.",
                422,
            )
        lid = str(target["id"])
        patch_body: dict[str, Any] = {}
        if new_name and str(new_name).strip():
            patch_body["name"] = str(new_name).strip()[:225]
        color = _resolve_color(color_name)
        if color is not None:
            patch_body["color"] = color
        if label_list_visibility:
            vis = _LABEL_LIST_VISIBILITY.get(str(label_list_visibility).strip().lower())
            if vis:
                patch_body["labelListVisibility"] = vis
        if message_list_visibility:
            mvis = _MESSAGE_LIST_VISIBILITY.get(str(message_list_visibility).strip().lower())
            if mvis:
                patch_body["messageListVisibility"] = mvis
        if not patch_body:
            raise _err("GMAIL_INVALID_LABEL", "Specify at least one label field to update.", 422)
        updated = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_MODIFY_SCOPE,
            method="PATCH",
            path=f"/labels/{lid}",
            json_body=patch_body,
        )
        return {
            "status": "updated",
            "previous_name": target.get("name"),
            "label": {
                "id": updated.get("id"),
                "name": updated.get("name"),
                "type": updated.get("type", "user"),
                "color": updated.get("color"),
                "label_list_visibility": updated.get("labelListVisibility"),
                "message_list_visibility": updated.get("messageListVisibility"),
            },
        }

    async def delete_label(self, *, user_id: str, name_or_id: str) -> dict[str, Any]:
        target = await self._find_user_label(user_id=user_id, name_or_id=name_or_id)
        if target is None:
            raise _err("GMAIL_NOT_FOUND", f"Label '{name_or_id}' was not found.", 404)
        if target.get("type") == "system":
            raise _err(
                "GMAIL_SYSTEM_LABEL_IMMUTABLE", "Gmail system labels cannot be deleted.", 422
            )
        lid = str(target["id"])
        await self._request(
            user_id=user_id,
            required_scope=_GMAIL_MODIFY_SCOPE,
            method="DELETE",
            path=f"/labels/{lid}",
        )
        return {
            "status": "deleted",
            "deleted_label_id": lid,
            "deleted_label_name": target.get("name"),
            "emails_safe_note": "Deleting a label never deletes emails; all emails remain safe in All Mail.",
        }

    # ------------------------------------------------------------------
    # Untrash (recover from Gmail Trash — gmail.modify)
    # ------------------------------------------------------------------

    async def untrash_messages(self, *, user_id: str, message_ids: Sequence[str]) -> dict[str, Any]:
        ids = [mid for mid in message_ids if isinstance(mid, str) and _SAFE_ID_RE.fullmatch(mid)][
            :25
        ]
        if not ids:
            raise _err("GMAIL_INVALID_ARGUMENT", "No messages selected to recover from Trash.", 422)
        recovered = 0
        for mid in ids:
            await self._request(
                user_id=user_id,
                required_scope=_GMAIL_MODIFY_SCOPE,
                method="POST",
                path=f"/messages/{mid}/untrash",
            )
            recovered += 1
        return {"status": "untrashed", "count": recovered}

    # ------------------------------------------------------------------
    # Drafts CRUD (gmail.readonly / gmail.compose)
    # ------------------------------------------------------------------

    async def list_drafts(
        self, *, user_id: str, limit: int = 15, timezone_name: str = "UTC"
    ) -> dict[str, Any]:
        bounded = max(1, min(int(limit), 25))
        listing = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_READONLY_SCOPE,
            method="GET",
            path="/drafts",
            params={"maxResults": bounded},
        )
        raw_drafts = listing.get("drafts") or []
        if not raw_drafts:
            return {"status": "ok", "count": 0, "drafts": [], "draft_ids": []}

        token = await self._token_for_scope(user_id=user_id, required_scope=_GMAIL_READONLY_SCOPE)
        headers = {"Authorization": f"Bearer {token}"}
        sem = asyncio.Semaphore(8)
        items: list[dict[str, Any]] = []
        draft_ids: list[str] = []

        async with httpx.AsyncClient(
            transport=self._transport, timeout=12.0, follow_redirects=False
        ) as client:

            async def fetch_draft(did: str) -> dict[str, Any] | None:
                async with sem:
                    try:
                        with suppress_instrumentation():
                            r = await client.get(
                                f"{_BASE}/drafts/{did}",
                                headers=headers,
                                params={"format": "metadata"},
                            )
                        return r.json() if r.status_code == 200 else None
                    except Exception:  # noqa: BLE001
                        return None

            valid_ids = [
                str(d["id"])
                for d in raw_drafts
                if isinstance(d, dict)
                and isinstance(d.get("id"), str)
                and _SAFE_ID_RE.fullmatch(d["id"])
            ][:bounded]
            fetched = await asyncio.gather(*(fetch_draft(did) for did in valid_ids))

        for did, detail in zip(valid_ids, fetched, strict=True):
            if not isinstance(detail, dict):
                continue
            msg = detail.get("message") or {}
            hdrs = _extract_draft_headers(msg)
            internal_ms = msg.get("internalDate")
            updated_local = None
            if isinstance(internal_ms, str) and internal_ms.isdigit():
                from datetime import UTC, datetime

                dt = datetime.fromtimestamp(int(internal_ms) / 1000.0, tz=UTC)
                _, updated_local, _ = format_local_timestamp(dt, timezone_name)
            draft_ids.append(did)
            items.append(
                {
                    "ordinal": len(draft_ids),
                    "subject": hdrs.get("subject") or "(no subject)",
                    "to": hdrs.get("to") or "(no recipient)",
                    "cc": hdrs.get("cc") or "",
                    "snippet": str(msg.get("snippet") or "")[:240],
                    "updated_at_local": updated_local,
                }
            )
        return {
            "status": "ok",
            "count": len(items),
            "drafts": items,
            "draft_ids": draft_ids,
        }

    async def get_draft(self, *, user_id: str, draft_id: str) -> dict[str, Any]:
        if not _SAFE_ID_RE.fullmatch(draft_id):
            raise _err("GMAIL_INVALID_ARGUMENT", "Invalid draft reference.", 422)
        from hushh_mcp.services.gmail_message_text import MessageTextError, cap_utf8, message_text

        detail = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_READONLY_SCOPE,
            method="GET",
            path=f"/drafts/{draft_id}",
            params={"format": "full"},
        )
        msg = detail.get("message") or {}
        hdrs = _extract_draft_headers(msg)
        body_text = ""
        try:
            body_text, _ = cap_utf8(message_text(msg.get("payload") or {}), 8000)
        except MessageTextError:
            body_text = str(msg.get("snippet") or "")
        return {
            "status": "ok",
            "subject": hdrs.get("subject") or "(no subject)",
            "to": hdrs.get("to") or "",
            "cc": hdrs.get("cc") or "",
            "bcc": hdrs.get("bcc") or "",
            "body": body_text,
        }

    async def create_draft(
        self,
        *,
        user_id: str,
        to: str,
        subject: str,
        body: str,
        cc: str = "",
        bcc: str = "",
    ) -> dict[str, Any]:
        raw = _build_raw_rfc822(to=to, subject=subject, body=body, cc=cc, bcc=bcc)
        created = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_COMPOSE_SCOPE,
            method="POST",
            path="/drafts",
            json_body={"message": {"raw": raw}},
        )
        return {
            "status": "draft_saved",
            "draft_id": created.get("id"),
            "to": to,
            "subject": subject,
        }

    async def update_draft(
        self,
        *,
        user_id: str,
        draft_id: str,
        to: str,
        subject: str,
        body: str,
        cc: str = "",
        bcc: str = "",
    ) -> dict[str, Any]:
        if not _SAFE_ID_RE.fullmatch(draft_id):
            raise _err("GMAIL_INVALID_ARGUMENT", "Invalid draft reference.", 422)
        raw = _build_raw_rfc822(to=to, subject=subject, body=body, cc=cc, bcc=bcc)
        updated = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_COMPOSE_SCOPE,
            method="PUT",
            path=f"/drafts/{draft_id}",
            json_body={"message": {"raw": raw}},
        )
        return {
            "status": "draft_updated",
            "draft_id": updated.get("id"),
            "to": to,
            "subject": subject,
        }

    async def delete_draft(self, *, user_id: str, draft_id: str) -> dict[str, Any]:
        if not _SAFE_ID_RE.fullmatch(draft_id):
            raise _err("GMAIL_INVALID_ARGUMENT", "Invalid draft reference.", 422)
        await self._request(
            user_id=user_id,
            required_scope=_GMAIL_COMPOSE_SCOPE,
            method="DELETE",
            path=f"/drafts/{draft_id}",
        )
        return {"status": "draft_deleted"}

    # ------------------------------------------------------------------
    # Gmail Settings: Filters, Vacation Responder, Signatures & Forwarding
    # ------------------------------------------------------------------

    async def list_filters(self, *, user_id: str) -> dict[str, Any]:
        data = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="GET",
            path="/settings/filters",
        )
        rows = data.get("filter") or []
        filters = [
            {
                "id": row.get("id"),
                "criteria": row.get("criteria") or {},
                "action": row.get("action") or {},
            }
            for row in rows
            if isinstance(row, dict)
        ]
        return {"status": "ok", "count": len(filters), "filters": filters}

    async def preview_filter_matches(
        self, *, user_id: str, query: str, max_sample: int = 5
    ) -> dict[str, Any]:
        """Count existing emails matching filter criteria using gmail.readonly."""
        q = str(query or "").strip()
        if not q:
            raise _err("GMAIL_INVALID_ARGUMENT", "Filter criteria cannot be empty.", 422)
        listing = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_READONLY_SCOPE,
            method="GET",
            path="/messages",
            params={"q": q, "maxResults": max(1, min(max_sample, 10))},
        )
        return {
            "status": "ok",
            "query": q,
            "estimated_matches": int(listing.get("resultSizeEstimate") or 0),
            "sample_count": len(listing.get("messages") or []),
        }

    async def create_filter(
        self,
        *,
        user_id: str,
        criteria: dict[str, Any],
        action: dict[str, Any],
    ) -> dict[str, Any]:
        if not criteria or not action:
            raise _err(
                "GMAIL_INVALID_ARGUMENT", "Filter needs both criteria and at least one action.", 422
            )
        # Resolve user label names inside addLabelIds / removeLabelIds if passed as names
        resolved_action = dict(action)
        for key in ("addLabelIds", "removeLabelIds"):
            raw_list = resolved_action.get(key)
            if isinstance(raw_list, list) and raw_list:
                resolved_ids: list[str] = []
                for item in raw_list:
                    val = str(item or "").strip()
                    if not val:
                        continue
                    upper = val.upper()
                    if upper in {
                        "INBOX",
                        "UNREAD",
                        "STARRED",
                        "IMPORTANT",
                        "SPAM",
                        "TRASH",
                        "CATEGORY_PERSONAL",
                        "CATEGORY_PROMOTIONS",
                        "CATEGORY_SOCIAL",
                        "CATEGORY_UPDATES",
                    }:
                        resolved_ids.append(upper)
                    else:
                        found = await self._find_user_label(user_id=user_id, name_or_id=val)
                        if found is None:
                            raise _err(
                                "GMAIL_NOT_FOUND", f"Label '{val}' not found. Create it first.", 404
                            )
                        resolved_ids.append(str(found["id"]))
                resolved_action[key] = resolved_ids

        created = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="POST",
            path="/settings/filters",
            json_body={"criteria": criteria, "action": resolved_action},
        )
        return {
            "status": "filter_created",
            "filter": {
                "id": created.get("id"),
                "criteria": created.get("criteria") or criteria,
                "action": created.get("action") or resolved_action,
            },
        }

    async def delete_filter(self, *, user_id: str, filter_id: str) -> dict[str, Any]:
        if not _SAFE_ID_RE.fullmatch(filter_id):
            raise _err("GMAIL_INVALID_ARGUMENT", "Invalid filter ID.", 422)
        await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="DELETE",
            path=f"/settings/filters/{filter_id}",
        )
        return {"status": "filter_deleted", "deleted_filter_id": filter_id}

    async def get_vacation(self, *, user_id: str) -> dict[str, Any]:
        data = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="GET",
            path="/settings/vacation",
        )
        return {
            "status": "ok",
            "vacation": {
                "enabled": bool(data.get("enableAutoReply")),
                "subject": data.get("responseSubject") or "",
                "message_plain": data.get("responseBodyPlainText") or "",
                "message_html": data.get("responseBodyHtml") or "",
                "restrict_to_contacts": bool(data.get("restrictToContacts")),
                "restrict_to_domain": bool(data.get("restrictToDomain")),
                "start_time_ms": data.get("startTime"),
                "end_time_ms": data.get("endTime"),
            },
        }

    async def update_vacation(
        self,
        *,
        user_id: str,
        enabled: bool,
        subject: str = "",
        message: str = "",
        restrict_to_contacts: bool = False,
        restrict_to_domain: bool = False,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "enableAutoReply": bool(enabled),
            "responseSubject": subject.strip(),
            "responseBodyPlainText": message,
            "restrictToContacts": bool(restrict_to_contacts),
            "restrictToDomain": bool(restrict_to_domain),
        }
        if start_time_ms is not None:
            body["startTime"] = int(start_time_ms)
        if end_time_ms is not None:
            body["endTime"] = int(end_time_ms)
        updated = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="PUT",
            path="/settings/vacation",
            json_body=body,
        )
        return {
            "status": "vacation_updated",
            "vacation": {
                "enabled": bool(updated.get("enableAutoReply")),
                "subject": updated.get("responseSubject") or "",
                "message_plain": updated.get("responseBodyPlainText") or "",
                "restrict_to_contacts": bool(updated.get("restrictToContacts")),
                "start_time_ms": updated.get("startTime"),
                "end_time_ms": updated.get("endTime"),
            },
        }

    async def list_send_as(self, *, user_id: str) -> dict[str, Any]:
        data = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="GET",
            path="/settings/sendAs",
        )
        aliases = [
            {
                "email": row.get("sendAsEmail"),
                "display_name": row.get("displayName") or "",
                "reply_to": row.get("replyToAddress") or "",
                "signature": row.get("signature") or "",
                "is_primary": bool(row.get("isPrimary")),
                "is_default": bool(row.get("isDefault")),
                "verification_status": row.get("verificationStatus") or "accepted",
            }
            for row in (data.get("sendAs") or [])
            if isinstance(row, dict)
        ]
        return {"status": "ok", "count": len(aliases), "aliases": aliases}

    async def update_send_as(
        self,
        *,
        user_id: str,
        send_as_email: str = "",
        signature: str | None = None,
        display_name: str | None = None,
        reply_to: str | None = None,
        make_default: bool | None = None,
    ) -> dict[str, Any]:
        target_email = str(send_as_email or "").strip()
        if not target_email:
            listed = await self.list_send_as(user_id=user_id)
            primary = next(
                (a for a in listed["aliases"] if a.get("is_primary")),
                listed["aliases"][0] if listed["aliases"] else None,
            )
            if primary is None or not primary.get("email"):
                raise _err("GMAIL_NOT_FOUND", "No Send-As address found for this account.", 404)
            target_email = str(primary["email"])
        if not _EMAIL_RE.fullmatch(target_email):
            raise _err("GMAIL_INVALID_ARGUMENT", "Invalid Send-As email address.", 422)
        patch: dict[str, Any] = {}
        if signature is not None:
            patch["signature"] = signature
        if display_name is not None:
            patch["displayName"] = display_name.strip()[:200]
        if reply_to is not None:
            patch["replyToAddress"] = reply_to.strip()
        if make_default is True:
            patch["isDefault"] = True
        if not patch:
            raise _err(
                "GMAIL_INVALID_ARGUMENT",
                "Specify signature, display_name, reply_to, or make_default.",
                422,
            )
        updated = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="PATCH",
            path=f"/settings/sendAs/{target_email}",
            json_body=patch,
        )
        return {
            "status": "send_as_updated",
            "alias": {
                "email": updated.get("sendAsEmail"),
                "display_name": updated.get("displayName") or "",
                "reply_to": updated.get("replyToAddress") or "",
                "signature": updated.get("signature") or "",
                "is_default": bool(updated.get("isDefault")),
            },
        }

    async def get_forwarding_settings(self, *, user_id: str) -> dict[str, Any]:
        auto_fwd = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="GET",
            path="/settings/autoForwarding",
        )
        addresses_payload = await self._request(
            user_id=user_id,
            required_scope=_GMAIL_SETTINGS_BASIC_SCOPE,
            method="GET",
            path="/settings/forwardingAddresses",
        )
        addresses = [
            {
                "email": row.get("forwardingEmail"),
                "verification_status": row.get("verificationStatus"),
            }
            for row in (addresses_payload.get("forwardingAddresses") or [])
            if isinstance(row, dict)
        ]
        return {
            "status": "ok",
            "auto_forwarding": {
                "enabled": bool(auto_fwd.get("enabled")),
                "email_address": auto_fwd.get("emailAddress") or "",
                "disposition": auto_fwd.get("disposition") or "leaveInInbox",
            },
            "forwarding_addresses": addresses,
        }


_service: GmailLabelsDraftsSettingsService | None = None


def get_gmail_labels_drafts_settings_service() -> GmailLabelsDraftsSettingsService:
    global _service
    if _service is None:
        _service = GmailLabelsDraftsSettingsService()
    return _service
