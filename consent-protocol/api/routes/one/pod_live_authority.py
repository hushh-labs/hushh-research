"""Connection-bound hub adapter over the existing directive ledger.

A pod may propose an action; it cannot manufacture a browser confirmation. This
adapter is memory-only transport bookkeeping, never a replacement ledger.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, NoReturn

from api.routes.one.live_context import sanitize_action_settlement, sanitize_live_context
from api.routes.one.pod_live_transport import AUTHORITY_METHODS, REQUEST_TYPE, RESULT_TYPE
from hushh_mcp.one_adk.action_tools import _directive_flags
from hushh_mcp.one_adk.voice_domain_policy import (
    is_voice_domain_disabled,
    is_voice_entirely_disabled,
    resolve_voice_domain,
    resolve_voice_domain_for_specialist,
)
from hushh_mcp.services.action_directive_ledger import (
    ActionConfirmationReceipt,
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    IssuedActionDirective,
)
from hushh_mcp.services.action_gateway import get_action_gateway_action


def _refuse() -> NoReturn:
    raise ActionDirectiveAuthorityError("voice directive binding refused")


def _wire(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    return {
        key: item.isoformat() if isinstance(item, datetime) else item
        for key, item in asdict(value).items()
    }


@dataclass
class _Binding:
    issued: IssuedActionDirective
    slots: dict[str, Any]
    trusted_activation: bool
    needs_confirmation: bool
    state: str = "issued"
    delivered: bool = False
    confirmation_sent: bool = False
    confirmation: ActionConfirmationReceipt | None = None
    confirm_observed: bool = False
    settlement: dict[str, str] | None = None


class HubVoiceAuthority:
    """One admitted Firebase owner and socket, backed by ActionDirectiveStore."""

    def __init__(
        self,
        *,
        user_id: str,
        session_id: str,
        require_access: Callable[[], Awaitable[None]],
        store: ActionDirectiveStore,
    ) -> None:
        if not user_id or not session_id:
            raise ValueError("voice owner and session required")
        self.user_id = user_id
        self.session_id = session_id
        self._require_access = require_access
        self._store = store
        self._bindings: dict[str, _Binding] = {}
        self._context: dict[str, Any] = {}
        self._lock = asyncio.Lock()

    def observe_browser(self, frame: dict[str, Any]) -> None:
        """Called only by the hub's authenticated browser reader, before forwarding."""
        if frame.get("type") == "app_context" or "appContext" in frame:
            context = frame.get("appContext")
            self._context = sanitize_live_context(context if isinstance(context, dict) else {})
            for existing in self._bindings.values():
                try:
                    self._require_current(existing)
                except ActionDirectiveAuthorityError:
                    existing.confirm_observed = False
            return
        key = {"action_confirm": "actionConfirmation", "action_settled": "actionSettlement"}.get(
            str(frame.get("type") or "")
        )
        payload = frame.get(key) if key else None
        if not isinstance(payload, dict):
            return
        binding = self._bindings.get(str(payload.get("directiveId") or ""))
        if binding is None or not binding.delivered:
            return
        if (
            payload.get("actionId") != binding.issued.action_id
            or payload.get("contextRevision") != binding.issued.context_revision
        ):
            return
        if key == "actionConfirmation":
            if binding.state == "issued":
                binding.confirm_observed = True
        elif binding.settlement is None:
            settled = sanitize_action_settlement(
                payload, {binding.issued.directive_id: binding.issued.action_id}
            )
            if settled is not None:
                settled["receipt"] = str(payload.get("receipt") or "")
                binding.settlement = settled

    async def dispatch(self, frame: dict[str, Any]) -> dict[str, Any]:
        """Consume an internal pod request; failures terminate the owning courier.

        Do not retry a failed mutation or forward its exception to either peer.
        The courier must close on failure, because acknowledgement can be lost.
        """
        if (
            set(frame) != {"type", "requestId", "method", "arguments"}
            or frame.get("type") != REQUEST_TYPE
            or not isinstance(frame.get("requestId"), str)
            or not 1 <= len(frame["requestId"]) <= 128
            or not isinstance(frame.get("method"), str)
            or not isinstance(frame.get("arguments"), dict)
        ):
            _refuse()
        result = await self.invoke(frame["method"], frame["arguments"])
        return {"type": RESULT_TYPE, "requestId": frame["requestId"], "ok": True, "result": result}

    async def invoke(self, method: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if method not in AUTHORITY_METHODS:
            _refuse()
        # Use the owning store's signature: no arbitrary method or extra fields.
        try:
            inspect.signature(getattr(ActionDirectiveStore, method)).bind(None, **arguments)
        except TypeError:
            _refuse()
        if arguments.get("user_id") != self.user_id:
            _refuse()
        if arguments.get("session_id", self.session_id) != self.session_id:
            _refuse()
        if arguments.get("conversation_id") is not None:
            _refuse()
        async with self._lock:
            await self._require_access()
            if method == "issue":
                return await self._issue(arguments)
            binding = self._bindings.get(str(arguments.get("directive_id") or ""))
            if binding is None or arguments.get("action_id") != binding.issued.action_id:
                _refuse()
            if (
                arguments.get("context_revision", binding.issued.context_revision)
                != binding.issued.context_revision
            ):
                _refuse()
            if method in {"confirm", "consume"}:
                self._require_current(binding)
            if method == "confirm":
                if binding.state != "issued" or not binding.confirm_observed:
                    _refuse()
                binding.confirm_observed = False
                result = await self._store.confirm(**{**arguments, "trusted_activation": True})
                binding.confirmation = result
                binding.state = "confirmed"
                return _wire(result)
            if method == "consume":
                if (
                    binding.state != "confirmed"
                    or binding.confirmation is None
                    or arguments.get("receipt") != binding.confirmation.receipt
                ):
                    _refuse()
                await self._store.consume(**arguments)
                binding.state = "consumed"
                return {}
            if method in {"settle", "settle_direct"}:
                observed = binding.settlement
                if observed is None:
                    _refuse()
                status = (
                    "succeeded"
                    if observed["status"] in {"succeeded", "started", "noop"}
                    else "failed"
                )
                if arguments.get("status") != status or arguments.get("reason_code") != (
                    observed["reason"] or observed["status"]
                ):
                    _refuse()
                if method == "settle":
                    if (
                        binding.state != "consumed"
                        or binding.confirmation is None
                        or arguments.get("receipt") != binding.confirmation.receipt
                        or observed["receipt"] != binding.confirmation.receipt
                    ):
                        _refuse()
                elif binding.needs_confirmation or binding.state != "issued" or observed["receipt"]:
                    _refuse()
                binding.settlement = None
                await getattr(self._store, method)(**arguments)
            else:
                # Cancellation only removes authority for this connection's id.
                await self._store.cancel_voice(**arguments)
            self._bindings.pop(binding.issued.directive_id, None)
            return {}

    def _executable_actions(self) -> list[str]:
        # sanitize_live_context derives this from the route and blocking layer.
        # A present empty/invalid execution set must never fall back to inventory.
        ids = self._context.get(
            "executable_action_ids", self._context.get("available_action_ids", [])
        )
        return ids if isinstance(ids, list) else []

    def _require_action(self, action_id: str, revision: str) -> dict[str, Any]:
        settings = self._context.get("voice_settings") or {}
        action = get_action_gateway_action(action_id)
        if (
            not isinstance(action, dict)
            or not action
            or not revision
            or self._context.get("context_revision") != revision
            or action_id not in self._executable_actions()
            or (action.get("execution_target") or {}).get("status") != "wired"
            or is_voice_entirely_disabled(settings)
            or is_voice_domain_disabled(
                resolve_voice_domain(action_id), settings.get("disabled_domains")
            )
        ):
            _refuse()
        return action

    def _require_current(self, binding: _Binding) -> None:
        if binding.issued.expires_at <= datetime.now(UTC):
            _refuse()
        action = self._require_action(binding.issued.action_id, binding.issued.context_revision)
        flags = _directive_flags(
            action,
            require_tap_confirmation=(self._context.get("voice_settings") or {}).get(
                "require_tap_confirmation"
            )
            is True,
        )
        if (
            flags["needsConfirmation"] != binding.needs_confirmation
            or flags["trustedActivationRequired"] != binding.trusted_activation
        ):
            _refuse()

    async def _issue(self, arguments: dict[str, Any]) -> dict[str, Any]:
        now = datetime.now(UTC)
        self._bindings = {
            key: item for key, item in self._bindings.items() if item.issued.expires_at > now
        }
        if len(self._bindings) >= 128 or arguments.get("channel") != "voice":
            _refuse()
        action_id = arguments.get("action_id")
        action = get_action_gateway_action(action_id) if isinstance(action_id, str) else None
        if not action or action_id not in self._executable_actions():
            _refuse()
        revision = self._context.get("context_revision")
        if not revision or arguments.get("context_revision") != revision:
            _refuse()
        self._require_action(action_id, revision)
        policy = action.get("execution_policy")
        if policy not in {"allow_direct", "confirm_required"}:
            _refuse()
        slots = arguments.get("slots")
        if not isinstance(slots, dict):
            _refuse()
        flags = _directive_flags(
            action,
            require_tap_confirmation=(self._context.get("voice_settings") or {}).get(
                "require_tap_confirmation"
            )
            is True,
        )
        trusted = flags["trustedActivationRequired"]
        issued = await self._store.issue(
            **{
                **arguments,
                "action_contract": action,
                "trusted_activation_required": trusted,
                "user_id": self.user_id,
                "channel": "voice",
                "session_id": self.session_id,
            }
        )
        self._bindings[issued.directive_id] = _Binding(
            issued=issued,
            slots=dict(slots),
            trusted_activation=trusted,
            needs_confirmation=flags["needsConfirmation"],
        )
        return _wire(issued)

    def _specialist_proposal(self, directive: dict[str, Any]) -> dict[str, Any]:
        """Translate a proposal into the existing owner-confirmed chat handoff.

        Translation is not payload authorization. Browser handlers and their
        authenticated endpoints still own confirmation and execution authority.
        """
        from hushh_mcp.one_adk.one_persona import _load_registry_agents
        from hushh_mcp.one_adk.text_runtime import OneTextDirective
        from hushh_mcp.services.one_directive_frames import one_directive_frames
        from hushh_mcp.services.route_orchestration_index import is_one_delegate_admitted

        kind, payload = directive.get("kind"), directive.get("payload")
        if kind not in {"action", "prompt"} or not isinstance(payload, dict):
            _refuse()
        if "actionId" in payload or any(
            payload.get(key) in {"publish_location_envelopes", "navigate"}
            for key in ("type", "kind")
            if isinstance(payload.get(key), str)
        ):
            _refuse()
        delegate = directive.get("delegateAgentId")
        gmail = kind == "prompt" and payload.get("kind") == "gmail_email_draft"
        if delegate in (None, "one"):
            if not gmail:
                _refuse()
            delegate = None
            policy_agent = "agent_email"
        elif not isinstance(delegate, str) or delegate not in _load_registry_agents():
            _refuse()
        else:
            policy_agent = delegate
        context = self._context
        settings = context.get("voice_settings") or {}
        if (
            not context.get("context_revision")
            or not context.get("route_family")
            or is_voice_entirely_disabled(settings)
            or is_voice_domain_disabled(
                resolve_voice_domain_for_specialist(policy_agent), settings.get("disabled_domains")
            )
            or is_one_delegate_admitted(context["route_family"], policy_agent) is False
        ):
            _refuse()
        frames = one_directive_frames(
            OneTextDirective(kind=kind, payload=payload, delegate_agent_id=delegate),
            conversation_text="",
        )
        if len(frames) != 1 or frames[0][0] != "specialist_directive":
            _refuse()
        translated = frames[0][1]
        return {
            "clientDirective": {
                **translated["directive"],
                "delegateAgentId": translated["delegate_agent_id"],
            }
        }

    def validate_outbound(self, frame: dict[str, Any]) -> dict[str, Any]:
        """Reject forged actionable frames; return server-owned authority fields."""
        if "actionConfirmationAccepted" in frame:
            payload = frame["actionConfirmationAccepted"]
            if not isinstance(payload, dict):
                _refuse()
            binding = self._bindings.get(str(payload.get("directiveId") or ""))
            if (
                binding is None
                or binding.state != "consumed"
                or binding.confirmation is None
                or binding.confirmation_sent
            ):
                _refuse()
            self._require_current(binding)
            if payload.get("receipt") != binding.confirmation.receipt:
                _refuse()
            binding.confirmation_sent = True
            return {
                "actionConfirmationAccepted": {
                    "directiveId": binding.issued.directive_id,
                    "receipt": binding.confirmation.receipt,
                    "expiresAt": binding.confirmation.expires_at.isoformat(),
                }
            }
        if "clientDirective" not in frame:
            return frame
        directive = frame["clientDirective"]
        if not isinstance(directive, dict):
            _refuse()
        payload = directive.get("payload")
        if isinstance(payload, dict) and "actionId" not in payload:
            return self._specialist_proposal(directive)
        if directive.get("kind") != "action":
            _refuse()
        if not isinstance(payload, dict):
            _refuse()
        binding = self._bindings.get(str(payload.get("directiveId") or ""))
        if (
            binding is None
            or binding.delivered
            or binding.state != "issued"
            or binding.issued.expires_at <= datetime.now(UTC)
            or self._context.get("context_revision") != binding.issued.context_revision
            or binding.issued.action_id not in self._executable_actions()
        ):
            _refuse()
        if (
            payload.get("actionId") != binding.issued.action_id
            or payload.get("slots", {}) != binding.slots
            or payload.get("contextRevision") != binding.issued.context_revision
        ):
            _refuse()
        self._require_current(binding)
        binding.delivered = True
        return {
            "clientDirective": {
                **directive,
                "payload": {
                    **payload,
                    "needsConfirmation": binding.needs_confirmation,
                    "trustedActivationRequired": binding.trusted_activation,
                    "expiresAt": binding.issued.expires_at.isoformat(),
                },
            }
        }
