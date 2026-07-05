"""Deterministic intent handler for the trusted-connections specialist.

One delegates "add/remove/list trusted connections" turns here. The parsing is
deterministic (regex), matching the repo's existing deterministic-planner style —
no LLM call is needed for these three intents. All writes go through
TrustedConnectionsService, so this is the single write surface for the graph.
"""

from __future__ import annotations

import logging
import re
from typing import Any

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
    r"\b(?:who\s+do\s+i\s+trust|list\s+(?:my\s+)?trusted\s+connections?|my\s+trusted\s+connections?|show\s+(?:my\s+)?trusted\s+connections?)\b",
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
    ) -> dict[str, Any]:
        text = (message or "").strip()
        conv = conversation_id or ""

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
            names = [str(c.get("displayName") or "someone") for c in exc.candidates]
            if names:
                listed = " or ".join(names)
                return self._reply(
                    f"I found more than one match for “{name}”: {listed}. Which one should I add?",
                    conv,
                    state_changed=False,
                )
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
        except IdentityUnresolvedError:
            return self._reply(
                f"I couldn't uniquely find “{name}” to remove. Can you be more specific?",
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

    @staticmethod
    def _reply(response: str, conv: str, *, state_changed: bool) -> dict[str, Any]:
        return {
            "response": response,
            "conversationId": conv,
            "isComplete": True,
            "stateChanged": state_changed,
        }
