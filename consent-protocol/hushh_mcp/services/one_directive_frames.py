"""One translator, One's directives -> chat SSE frames, shared by hub and pod.

Extracted from ``api/routes/kai/agent_chat.py`` so the pod relay can emit the
BYTE-IDENTICAL frames the hub emits for the same directive. Two translators
would drift on exactly the fields that matter -- execution policy, trusted
activation, the tool_start/tool_waiting pair -- and a pod card that rendered
differently from a hub card is a parity break the user sees. One function, both
callers, guaranteed identical.

This is pure translation. It grants nothing and issues nothing: the caller
(the hub chat route, or the relay) owns authorization and ledger issuance and
passes the resulting ``directive_id`` / ``expires_at`` in. A directive reaching
this function is already an instruction the caller decided to authorize.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from hushh_mcp.one_adk.text_runtime import OneTextDirective
from hushh_mcp.services.action_gateway import get_action_gateway_action

#: Specialists never surfaced as a delegate directive to the app. Personal
#: information is One's own grounding, not a screen the app navigates to.
EXCLUDED_AGENT_CHAT_SPECIALISTS = frozenset({"agent_personal_information"})


def one_directive_frames(
    directive: OneTextDirective,
    *,
    conversation_text: str,
    directive_id: str | None = None,
    conversation_id: str | None = None,
    context_revision: str | None = None,
    expires_at: str | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    """Translate One's canonical directive into the existing chat SSE frames.

    A delegate directive becomes a single ``specialist_directive`` frame; an
    ``action`` directive becomes the ``tool_start`` + ``tool_waiting`` pair the
    frontend already knows how to render and confirm. Anything else yields no
    frames. ``action_id`` is re-validated against the gateway here, so an unknown
    id (a pod on a newer/older gateway, say) produces no frame rather than a
    card the app cannot honor.
    """
    if (
        directive.delegate_agent_id
        and directive.delegate_agent_id not in EXCLUDED_AGENT_CHAT_SPECIALISTS
    ):
        return [
            (
                "specialist_directive",
                {
                    "delegate_agent_id": directive.delegate_agent_id,
                    "directive": {
                        "kind": directive.kind,
                        "payload": directive.payload,
                    },
                    "message": conversation_text,
                    "state_changed": False,
                },
            )
        ]

    # Ported from main during the 2026-08-26 sync. This branch had extracted this
    # function out of `agent_chat.py` into this module; main edited the inline copy
    # it still has, adding the block below. Taking this branch's side wholesale --
    # correct for the extraction -- would have deleted a real capability, which is
    # the failure the sync SOP's "port genuinely new main content" step exists for.
    #
    # Personal Gmail drafting is a One-owned, client-only prompt directive.
    # It opens an editable card and never runs a provider action. Keep this
    # allowlist narrow so arbitrary prompt directives cannot become UI effects.
    if (
        directive.kind == "prompt"
        and str(directive.payload.get("kind") or "") == "gmail_email_draft"
    ):
        return [
            (
                "specialist_directive",
                {
                    "delegate_agent_id": "one",
                    "directive": {
                        "kind": directive.kind,
                        "payload": directive.payload,
                    },
                    "message": conversation_text,
                    "state_changed": False,
                },
            )
        ]

    if directive.kind != "action":
        return []
    action_id = str(directive.payload.get("actionId") or "").strip()
    action = get_action_gateway_action(action_id)
    if action is None:
        return []
    label = str(action.get("label") or action_id).strip()
    receipt = conversation_text.strip() or f"{label} in the app."
    payload: dict[str, Any] = {
        "call_id": directive_id or f"one_text_{uuid4().hex}",
        "action_id": action_id,
        "label": label,
        "execution": "frontend",
        "slots": directive.payload.get("slots")
        if isinstance(directive.payload.get("slots"), dict)
        else {},
        "message": receipt,
        "execution_policy": str(
            (action.get("risk") or {}).get("execution_policy") or "allow_direct"
        ),
        "requires_confirmation": True,
        "trusted_activation_required": bool(
            directive.payload.get("trustedActivationRequired") is True
            or action.get("activation_policy") == "trusted_activation_required"
        ),
    }
    if directive_id is not None:
        payload["directive_id"] = directive_id
    if conversation_id is not None:
        payload["conversation_id"] = conversation_id
    if context_revision is not None:
        payload["context_revision"] = context_revision
    if expires_at is not None:
        payload["expires_at"] = expires_at
    return [
        ("tool_start", payload),
        (
            "tool_waiting",
            {
                **payload,
                "status": "waiting_for_frontend",
            },
        ),
    ]


__all__ = ["EXCLUDED_AGENT_CHAT_SPECIALISTS", "one_directive_frames"]
