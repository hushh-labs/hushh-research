"""A standby answers nothing and accepts no write except sync import: one request gate.

The request-level half of the standby refusal (the log-level half is
``pod_role_log.RoleAwareCommitLog.append``). Every non-safe HTTP request and every
websocket -- turns, the live session, the Puppy relay, memory, Files, session,
config, the tick, migration, upgrade handoff -- passes through here, so no route
needs to remember to ask. Safe methods (GET, HEAD, OPTIONS) pass: reads change
nothing and a standby's status must stay observable.

What a standby still accepts, by name:

* ``/pod/sync/head``, ``/pod/sync/import``, ``/pod/sync/set-role`` -- the sync
  protocol and the promotion it ends in. Each carries its own hub proof.
* ``/pod/migration/erasure/*`` -- account deletion erases a standby exactly like a
  primary (E10). The fence replaces the head; it is not an append.

Upgrade handoff (``/api/one/pod/upgrade/prepare`` and ``release``) is refused on a
standby on purpose: ``prepare`` appends lifecycle markers to the log, which would
fork the standby's chain. A standby is upgraded by redeploying it.

On a pod without durable storage, or without a role object (every pod today), the
role is primary at epoch 0 and every request passes exactly as before. A role that
cannot be confirmed refuses (E3); it never reads as primary.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from hushh_mcp.services.pod_role import CODE_STANDBY, PodRoleRefused, require_serving_role

logger = logging.getLogger(__name__)

SAFE_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "OPTIONS"})

#: The only non-safe paths a standby serves.
STANDBY_ALLOWED_EXACT: frozenset[str] = frozenset(
    {"/pod/sync/head", "/pod/sync/import", "/pod/sync/set-role"}
)
STANDBY_ALLOWED_PREFIXES: tuple[str, ...] = ("/pod/migration/erasure/",)


def standby_may_serve(path: str) -> bool:
    clean = str(path or "")
    if clean != "/" and clean.endswith("/"):
        clean = clean.rstrip("/")
    return clean in STANDBY_ALLOWED_EXACT or clean.startswith(STANDBY_ALLOWED_PREFIXES)


def needs_role_check(scope: dict[str, Any]) -> bool:
    kind = scope.get("type")
    if kind == "websocket":
        return True
    if kind != "http":
        return False
    if str(scope.get("method") or "").upper() in SAFE_METHODS:
        return False
    return not standby_may_serve(str(scope.get("path") or ""))


class PodRoleGuard:
    """Pure ASGI. Refuses with a typed body; never reveals more than the role code."""

    def __init__(self, app: Any) -> None:
        self._app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if not needs_role_check(scope):
            await self._app(scope, receive, send)
            return
        try:
            await require_serving_role()
        except PodRoleRefused as refusal:
            logger.info(
                "pod_role.refused path=%s code=%s", str(scope.get("path") or ""), refusal.code
            )
            await self._refuse(scope, send, refusal)
            return
        await self._app(scope, receive, send)

    @staticmethod
    async def _refuse(scope: dict[str, Any], send: Any, refusal: PodRoleRefused) -> None:
        if scope.get("type") == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": refusal.code})
            return
        status = 409 if refusal.code == CODE_STANDBY else 503
        body = json.dumps({"detail": str(refusal), "code": refusal.code}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


__all__ = [
    "SAFE_METHODS",
    "STANDBY_ALLOWED_EXACT",
    "STANDBY_ALLOWED_PREFIXES",
    "PodRoleGuard",
    "needs_role_check",
    "standby_may_serve",
]
