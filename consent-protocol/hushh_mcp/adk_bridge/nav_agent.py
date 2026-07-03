"""Inline A2A runtime for Agent Nav.

This file adds an executable A2A surface for the existing Nav specialist without
changing the core Nav manifest or the working Location A2A path.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from hushh_mcp.adk_bridge.contract import A2ADirective, A2ATask, SpecialistTurnResult
from hushh_mcp.adk_bridge.delegation import validate_a2a_consent_token
from hushh_mcp.consent.scope_helpers import get_scope_display_metadata
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.services.consent_center_service import ConsentCenterService

DELEGATED_MODEL = "one+nav"
NAV_AGENT_ID = "agent_nav"


class NavAgent:
    agent_id = NAV_AGENT_ID

    def __init__(self, manifest_path: str | Path | None = None) -> None:
        self._manifest_path = Path(manifest_path) if manifest_path else _default_manifest_path()
        self._manifest = ManifestLoader.load(str(self._manifest_path))

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        hussh_task = _hussh_task(task)
        validation = validate_a2a_consent_token(self.agent_id, hussh_task.consent_token)
        if not validation.ok:
            hussh_result = _hussh_result(
                conversation_id=hussh_task.conversation_id,
                text=(
                    "Nav cannot review this request without an active "
                    f"{validation.required_scope.value} consent grant."
                ),
                directive=_hussh_directive(
                    kind="prompt",
                    payload={
                        "kind": "consent_required",
                        "agentId": self.agent_id,
                        "requiredScope": validation.required_scope.value,
                        "reason": validation.reason,
                    },
                ),
                is_complete=True,
                model=DELEGATED_MODEL,
                metadata={"status": "needs_consent", "reason": validation.reason},
            )
            return _research_result(hussh_result)

        message = (hussh_task.message or "").strip()
        timezone = _safe_timezone(hussh_task.metadata.get("timezone"))
        answer_text, directive = await self._answer(
            message, user_id=hussh_task.user_id, timezone=timezone
        )
        hussh_result = _hussh_result(
            conversation_id=hussh_task.conversation_id,
            text=answer_text,
            directive=directive,
            is_complete=True,
            model=DELEGATED_MODEL,
            metadata={
                "status": "completed",
                "agent_id": self.agent_id,
                "required_scope": validation.required_scope.value,
            },
        )
        return _research_result(hussh_result)

    async def _answer(
        self, message: str, *, user_id: str, timezone: ZoneInfo
    ) -> tuple[str, Any | None]:
        if not message:
            return (
                "Nav is ready to review consent, scope release, vault access, "
                "deletion, and revocation questions.",
                None,
            )
        if _is_previous_consent_query(message):
            return await self._previous_consent_answer(user_id, timezone=timezone)
        if _is_active_consent_query(message):
            return await self._active_consent_answer(user_id, timezone=timezone)
        return (
            f"For this request: {message}. I can help review consent requests, "
            "explain what access was granted, "
            "and help you approve, narrow, or revoke access. Ask me to show active, "
            "pending, or revoked consent requests.",
            None,
        )

    async def _active_consent_answer(
        self, user_id: str, *, timezone: ZoneInfo
    ) -> tuple[str, Any | None]:
        try:
            payload = await ConsentCenterService().list_center(
                user_id,
                actor="investor",
                surface="active",
                top=10,
            )
        except Exception:
            return "Nav could not load approved consent requests right now. Please try again.", None

        grants = list(payload.get("items") or [])
        total = int(payload.get("total") or len(grants))
        if not grants:
            return "You do not have any approved consent requests right now.", None

        lines = [
            f"You have {total} approved consent request"
            f"{'' if total == 1 else 's'} active right now:"
        ]
        action_items: list[dict[str, Any]] = []
        for index, grant in enumerate(grants[:10], start=1):
            label = _entry_label(grant)
            access = _friendly_scope(grant)
            expires = _friendly_expiry(grant, timezone=timezone)
            lines.append(f"{index}. {label} can {access}{expires}.")
            action_item = _consent_action_item(grant, label=label, access=access)
            if action_item is not None:
                action_items.append(action_item)
        if total > len(grants):
            lines.append(f"There are {total - len(grants)} more approved requests.")
        directive = (
            _hussh_directive(
                kind="prompt",
                payload={"kind": "consent_actions", "items": action_items},
            )
            if action_items
            else None
        )
        return "\n".join(lines), directive

    async def _previous_consent_answer(
        self, user_id: str, *, timezone: ZoneInfo
    ) -> tuple[str, Any | None]:
        try:
            payload = await ConsentCenterService().list_center(
                user_id,
                actor="investor",
                surface="previous",
                top=10,
            )
        except Exception:
            return "Nav could not load revoked consent requests right now. Please try again.", None

        entries = list(payload.get("items") or [])
        total = int(payload.get("total") or len(entries))
        if not entries:
            return "You do not have any revoked or previous consent requests right now.", None

        lines = [f"You have {total} previous consent request{'' if total == 1 else 's'}:"]
        for index, entry in enumerate(entries[:10], start=1):
            label = _entry_label(entry)
            access = _friendly_scope(entry)
            ended = _friendly_terminal_time(entry, timezone=timezone)
            status = str(entry.get("status") or "previous").strip().lower()
            lines.append(f"{index}. {label} had access to {access}{ended} ({status}).")
        if total > len(entries):
            lines.append(f"There are {total - len(entries)} more previous requests.")
        return "\n".join(lines), None


_singleton: NavAgent | None = None


def get_nav_a2a() -> NavAgent:
    global _singleton
    if _singleton is None:
        _singleton = NavAgent()
    return _singleton


def _default_manifest_path() -> Path:
    return Path(__file__).resolve().parents[1] / "agents" / "nav" / "agent.yaml"


def _is_active_consent_query(message: str) -> bool:
    text = message.lower()
    consent_words = ("consent", "access", "grant", "permission", "scope")
    active_words = (
        "approved",
        "active",
        "granted",
        "request",
        "requests",
        "who has access",
    )
    list_words = ("show", "list", "all", "what", "who")
    return (
        any(word in text for word in consent_words)
        and any(word in text for word in active_words)
        and any(word in text for word in list_words)
    )


def _is_previous_consent_query(message: str) -> bool:
    text = message.lower()
    consent_words = ("consent", "access", "grant", "permission", "scope", "request")
    previous_words = ("revoked", "revoke", "expired", "previous", "past", "history", "ended")
    list_words = ("show", "list", "all", "what", "who", "about")
    return (
        any(word in text for word in consent_words)
        and any(word in text for word in previous_words)
        and any(word in text for word in list_words)
    )


def _entry_label(entry: dict[str, Any]) -> str:
    for key in ("counterpart_label", "counterpart_email", "counterpart_id"):
        value = str(entry.get(key) or "").strip()
        if value:
            return value
    return "An approved app or agent"


def _friendly_scope(entry: dict[str, Any]) -> str:
    scope = str(entry.get("scope") or "").strip()
    if scope == "cap.location.live.view":
        return "view your live location"
    if scope == "cap.location.live.share":
        return "share your live location"
    if scope == "cap.location.live.request":
        return "request your live location"
    if scope == "cap.location.live.revoke":
        return "revoke a live-location share"
    if scope == "cap.location.live.refer_request":
        return "refer a live-location access request"
    description = str(entry.get("scope_description") or "").strip()
    if description:
        return f"access {description[0].lower()}{description[1:]}"
    if scope:
        try:
            label = str(get_scope_display_metadata(scope).get("label") or "").strip()
        except Exception:
            label = ""
        if label:
            return f"access {label[0].lower()}{label[1:]}"
        return f"access {scope}"
    return "access an approved scope"


def _consent_action_item(
    entry: dict[str, Any],
    *,
    label: str,
    access: str,
) -> dict[str, Any] | None:
    entry_id = str(entry.get("id") or "").strip()
    scope = str(entry.get("scope") or "").strip()
    metadata = dict(entry.get("metadata") or {})
    request_source = str(metadata.get("request_source") or "").strip()
    is_location_grant = (
        entry_id.startswith("one_location_grant:")
        or request_source == "one_location_share_grant"
        or scope.startswith("cap.location.")
    )
    if not is_location_grant:
        return None

    grant_id = str(metadata.get("grant_id") or "").strip()
    if not grant_id and entry_id.startswith("one_location_grant:"):
        grant_id = entry_id.split(":", 1)[1].strip()
    if not grant_id:
        raw_id = str(entry.get("id") or "").strip()
        if raw_id and not raw_id.startswith("one_location_"):
            grant_id = raw_id
    if not grant_id:
        return None

    item_id = f"one_location_grant:{grant_id}"
    action_metadata = {
        **metadata,
        "request_source": "one_location_share_grant",
        "grant_id": grant_id,
    }
    return {
        "id": item_id,
        "label": label,
        "summary": f"{label} can {access}",
        "scope": scope,
        "expiresAt": entry.get("expires_at"),
        "metadata": action_metadata,
        "actions": ["revoke", "details"],
    }


def _friendly_expiry(entry: dict[str, Any], *, timezone: ZoneInfo) -> str:
    expires = str(entry.get("expires_at") or "").strip()
    if not expires:
        return ""
    parsed = _parse_datetime(expires)
    if parsed is None:
        return f" until {expires}"
    local_expires = parsed.astimezone(timezone)
    local_now = datetime.now(UTC).astimezone(timezone)
    day_label = local_expires.strftime("%b %-d, %Y")
    if local_expires.date() == local_now.date():
        day_label = "today"
    elif (local_expires.date() - local_now.date()).days == 1:
        day_label = "tomorrow"
    time_label = local_expires.strftime("%-I:%M %p %Z")
    return f" until {day_label} at {time_label}"


def _friendly_terminal_time(entry: dict[str, Any], *, timezone: ZoneInfo) -> str:
    for key in ("revoked_at", "resolved_at", "expires_at", "updated_at", "issued_at"):
        value = str(entry.get(key) or "").strip()
        if not value:
            continue
        parsed = _parse_datetime(value)
        if parsed is None:
            return f" until {value}"
        local_value = parsed.astimezone(timezone)
        local_now = datetime.now(UTC).astimezone(timezone)
        day_label = local_value.strftime("%b %-d, %Y")
        if local_value.date() == local_now.date():
            day_label = "today"
        elif (local_value.date() - local_now.date()).days == -1:
            day_label = "yesterday"
        time_label = local_value.strftime("%-I:%M %p %Z")
        return f" until {day_label} at {time_label}"
    return ""


def _parse_datetime(value: str) -> datetime | None:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _safe_timezone(value: Any) -> ZoneInfo:
    name = str(value or "").strip()
    if not name:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(name)
    except (ValueError, ZoneInfoNotFoundError):
        return ZoneInfo("UTC")


def _hussh_task(task: A2ATask) -> Any:
    _ensure_hussh_package()
    from hussh import A2ATask as HusshA2ATask

    return HusshA2ATask(
        user_id=task.user_id,
        consent_token=task.consent_token,
        conversation_id=task.conversation_id,
        message=task.message,
        payload={"delegate_result": task.delegate_result} if task.delegate_result else {},
        metadata={"timezone": task.timezone} if task.timezone else {},
    )


def _hussh_directive(*, kind: str, payload: dict[str, Any]) -> Any:
    _ensure_hussh_package()
    from hussh import A2ADirective as HusshA2ADirective

    return HusshA2ADirective(kind=kind, payload=payload)


def _hussh_result(
    *,
    conversation_id: str | None,
    text: str,
    directive: Any = None,
    is_complete: bool,
    model: str,
    metadata: dict[str, Any],
) -> Any:
    _ensure_hussh_package()
    from hussh import A2AResult as HusshA2AResult

    return HusshA2AResult(
        conversation_id=conversation_id or "",
        text=text,
        directive=directive,
        is_complete=is_complete,
        model=model,
        metadata=metadata,
    )


def _research_result(result: Any) -> SpecialistTurnResult:
    directive = None
    if result.directive is not None:
        directive = A2ADirective(
            kind=result.directive.kind,
            payload=result.directive.payload,
        )
    return SpecialistTurnResult(
        conversation_id=result.conversation_id,
        text=result.text,
        directive=directive,
        is_complete=result.is_complete,
        state_changed=result.state_changed,
        model=result.model or DELEGATED_MODEL,
    )


def _ensure_hussh_package() -> None:
    try:
        import hussh  # noqa: F401

        return
    except ModuleNotFoundError:
        checkout_path = (
            Path(__file__).resolve().parents[3].parent / "hussh.dev" / "packages" / "sdk"
        )
        if checkout_path.exists() and str(checkout_path) not in sys.path:
            sys.path.insert(0, str(checkout_path))
