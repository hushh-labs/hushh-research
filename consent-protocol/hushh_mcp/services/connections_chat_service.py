"""Deterministic intent handler for the trusted-connections specialist.

One delegates "add/remove/list trusted connections" turns here. The parsing is
deterministic (regex), matching the repo's existing deterministic-planner style —
no LLM call is needed for these three intents. All writes go through
TrustedConnectionsService, so this is the single write surface for the graph.

Disambiguation reuses the SAME selection round-trip the Location specialist uses:
when a name matches more than one directory person, we return a coordinate-free
``clientPrompt`` (kind ``select``) whose option ``ref``s carry the real
``trustedUserId`` (plus a ``label`` and the ``op`` so the follow-up is
self-contained). The frontend renders the pick-list and sends the chosen ref back
as a ``delegate_result`` selection, which routes to THIS agent (bypassing the
classifier) and completes the add/remove.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from uuid import uuid4

from hushh_mcp.services.trusted_connections_service import (
    IdentityUnresolvedError,
    TrustedConnectionsError,
    TrustedConnectionsService,
)

logger = logging.getLogger(__name__)

_ADD_RE = re.compile(
    r"\badd\s+(?P<name>.+?)\s+(?:to|into)\s+(?:my\s+)?trusted\s+connections?\b",
    re.IGNORECASE,
)
_REMOVE_RE = re.compile(
    r"\b(?:remove|delete|drop)\s+(?P<name>.+?)\s+(?:from\s+)?(?:my\s+)?trusted\s+connections?\b",
    re.IGNORECASE,
)
_LIST_RE = re.compile(
    r"\b(?:who\s+do\s+i\s+trust|people\s+i\s+trust|list\s+(?:my\s+)?trusted\s+connections?|my\s+trusted\s+connections?|show\s+(?:my\s+)?trusted\s+connections?)\b",
    re.IGNORECASE,
)

_HELP = (
    "I manage your trusted connections. Try: “add Alice to my trusted "
    "connections”, “remove Bob from my trusted connections”, or “who do I trust”."
)


class ConnectionsChatService:
    def __init__(self, service: TrustedConnectionsService | None = None) -> None:
        self._service = service or TrustedConnectionsService()

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None,
        consent_token: str | None = None,
        conversation_id: str | None = None,
        selection_result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        conv = conversation_id or ""

        # A disambiguation pick coming back from the frontend.
        if selection_result is not None:
            return self._complete_selection(user_id, selection_result, conv)

        text = (message or "").strip()

        add = _ADD_RE.search(text)
        if add:
            return self._add(user_id, add.group("name").strip(), conv)

        remove = _REMOVE_RE.search(text)
        if remove:
            return self._remove(user_id, remove.group("name").strip(), conv)

        if _LIST_RE.search(text):
            return self._list(user_id, conv)

        return self._reply(_HELP, conv, state_changed=False)

    # ---- intents ----
    def _add(self, user_id: str, name: str, conv: str) -> dict[str, Any]:
        try:
            self._service.add_connection(user_id, query=name)
        except IdentityUnresolvedError as exc:
            if len(exc.candidates) > 1:
                return self._selection_prompt(name, exc.candidates, op="add", conv=conv)
            return self._reply(
                f"I couldn't find “{name}” in your directory yet, so I didn't add anyone.",
                conv,
                state_changed=False,
            )
        except TrustedConnectionsError as exc:
            return self._reply(exc.message, conv, state_changed=False)
        return self._reply(f"Added {name} to your trusted connections.", conv, state_changed=True)

    def _remove(self, user_id: str, name: str, conv: str) -> dict[str, Any]:
        try:
            target = self._service._resolve_query(user_id, name)  # noqa: SLF001
        except IdentityUnresolvedError as exc:
            if len(exc.candidates) > 1:
                return self._selection_prompt(name, exc.candidates, op="remove", conv=conv)
            return self._reply(
                f"I couldn't find “{name}” to remove, so nothing changed.",
                conv,
                state_changed=False,
            )
        result = self._service.remove_connection(user_id, target)
        if result.get("removed"):
            return self._reply(
                f"Removed {name} from your trusted connections.", conv, state_changed=True
            )
        return self._reply(f"{name} wasn't in your trusted connections.", conv, state_changed=False)

    def _list(self, user_id: str, conv: str) -> dict[str, Any]:
        rows = self._service.list_connections(user_id)
        if not rows:
            return self._reply(
                "You don't have any trusted connections yet.", conv, state_changed=False
            )
        names = [str(r.get("displayName") or r.get("trustedUserId") or "someone") for r in rows]
        return self._reply(
            "Your trusted connections: " + ", ".join(names) + ".",
            conv,
            state_changed=False,
        )

    # ---- selection round-trip ----
    def _selection_prompt(
        self, name: str, candidates: list[dict[str, Any]], *, op: str, conv: str
    ) -> dict[str, Any]:
        """Build a coordinate-free select prompt whose refs carry the real ids.

        Mirrors the Location specialist's clientPrompt contract so the shared
        frontend pick-card renders it and rounds-trips the choice back here.
        """
        verb = "add" if op == "add" else "remove"
        options = [
            {
                "label": str(c.get("displayName") or "Someone"),
                "ref": {
                    "trustedUserId": str(c.get("userId") or ""),
                    "label": str(c.get("displayName") or "Someone"),
                    "op": op,
                },
                "hint": None,
            }
            for c in candidates
            if c.get("userId")
        ]
        prompt = {
            "id": "prm-" + uuid4().hex[:12],
            "kind": "select",
            "purpose": f"{op}_trusted_connection",
            "question": f"Which “{name}” should I {verb}?",
            "options": options,
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": False,
        }
        return self._reply(
            f"I found more than one match for “{name}”. Which one?",
            conv,
            state_changed=False,
            client_prompt=prompt,
        )

    def _complete_selection(
        self, user_id: str, selection_result: dict[str, Any], conv: str
    ) -> dict[str, Any]:
        if str(selection_result.get("status")) == "cancelled":
            return self._reply("Okay, I won't change anything.", conv, state_changed=False)

        selected = selection_result.get("selected") or []
        chosen = selected[0] if selected and isinstance(selected[0], dict) else {}
        trusted_user_id = str(chosen.get("trustedUserId") or "")
        op = str(chosen.get("op") or "add")
        label = str(chosen.get("label") or selection_result.get("display") or "them")

        if not trusted_user_id:
            return self._reply(
                "I didn't catch who you picked — try again?", conv, state_changed=False
            )

        try:
            if op == "remove":
                result = self._service.remove_connection(user_id, trusted_user_id)
                if result.get("removed"):
                    return self._reply(
                        f"Removed {label} from your trusted connections.",
                        conv,
                        state_changed=True,
                    )
                return self._reply(
                    f"{label} wasn't in your trusted connections.", conv, state_changed=False
                )
            self._service.add_connection(user_id, trusted_user_id=trusted_user_id)
        except TrustedConnectionsError as exc:
            return self._reply(exc.message, conv, state_changed=False)
        return self._reply(f"Added {label} to your trusted connections.", conv, state_changed=True)

    @staticmethod
    def _reply(
        response: str,
        conv: str,
        *,
        state_changed: bool,
        client_prompt: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        out: dict[str, Any] = {
            "response": response,
            "conversationId": conv,
            "isComplete": True,
            "stateChanged": state_changed,
        }
        if client_prompt is not None:
            out["clientPrompt"] = client_prompt
            # A prompt turn is a mid-conversation ask, not a completed action.
            out["isComplete"] = False
        return out
