"""The pod's front door once its ingress is public: an in-process path policy.

Cloud Run IAM is service-wide. The moment a pod accepts a browser and a device
directly (``PodSpec.ingress = direct``: public ingress, ``allUsers`` invoker), the
``run.invoker`` lock that used to keep ``/pod/info``, ``/pod/public-key``, the
maintenance tick, the migration routes and the A2A door hub-only stops applying.
A sidecar cannot restore that per path, because the three admission seams all
assert one container. One middleware can, and this is it.

Two surfaces:

* **App surface.** Health, the session routes, status, config, the turn, the
  conversation close, the Puppy relay. These carry their own authentication (a pod
  session bearer, or nothing for health) and are reachable by anyone who can reach
  the pod.
* **Machine wall.** Everything else requires the Google ID token the hub already
  sends with every call it makes to a pod, verified with the same
  ``verify_scheduler_request`` the tick and the migration routes use, against the
  audiences this pod may be called by (its own URL, with or without a trailing
  slash, its bare host, and the configured tick audience) and the caller emails
  already rendered into every pod. A request that fails answers 404, never 401 or
  403: the wall is not an oracle for which routes exist. A websocket that fails is
  closed 1008 before it is accepted.

The wall is always on inside a pod. It needs no configuration because it reuses
what every pod already has, and it must not be a switch: a pod whose ingress is
widened before its wall is up would serve its key and its migration door to the
public for as long as the switch stayed off.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Callable, Optional

from hushh_mcp.services.scheduler_identity import (
    SchedulerIdentity,
    SchedulerIdentityError,
    verify_scheduler_request,
)

logger = logging.getLogger(__name__)

#: Exact paths and prefixes that carry their own authentication (or none, for
#: health) and are therefore reachable without a hub identity.
APP_SURFACE_EXACT: frozenset[str] = frozenset(
    {
        "/health",
        "/health/ready",
        "/health/capabilities",
        "/api/one/pod/status",
        "/api/one/pod/config",
        "/api/one/pod/turn",
        "/api/one/puppy/relay",
    }
)
APP_SURFACE_PREFIXES: tuple[str, ...] = (
    "/api/one/pod/session/",
    "/api/one/pod/conversation/",
)

_NOT_FOUND = json.dumps({"detail": "not found"}).encode("utf-8")


def is_app_surface(path: str) -> bool:
    """Whether ``path`` is on the app surface. A trailing slash never widens it."""
    clean = str(path or "")
    if clean != "/" and clean.endswith("/"):
        clean = clean.rstrip("/")
    if clean in APP_SURFACE_EXACT:
        return True
    if clean.startswith(APP_SURFACE_PREFIXES):
        # The conversation prefix admits only the close verb; anything else under
        # it is a machine route until a lane names it here.
        if clean.startswith("/api/one/pod/conversation/"):
            return clean.endswith("/close")
        return True
    return False


def hub_caller_allowlist() -> tuple[str, ...]:
    """The union of the two allowlists every pod is already rendered with."""
    names: set[str] = set()
    for env in ("HUSSH_POD_HUB_CALLER_EMAILS", "HUSSH_POD_TICK_ALLOWED_EMAILS"):
        for part in str(os.getenv(env) or "").split(","):
            if part.strip():
                names.add(part.strip().lower())
    return tuple(sorted(names))


def _header(headers: Any, name: str) -> str:
    wanted = name.lower().encode("latin-1")
    for key, value in headers or ():
        if key.lower() == wanted:
            return value.decode("latin-1").strip()
    return ""


def accepted_audiences(scope: dict[str, Any]) -> tuple[str, ...]:
    """Every spelling of this pod's own address a hub-minted token may carry."""
    headers = scope.get("headers") or ()
    host = _header(headers, "host")
    proto = _header(headers, "x-forwarded-proto") or str(scope.get("scheme") or "https")
    candidates: list[str] = []
    if host:
        candidates.extend((f"{proto}://{host}", f"{proto}://{host}/", host))
        if proto != "https":
            candidates.extend((f"https://{host}", f"https://{host}/"))
    tick = str(os.getenv("HUSSH_POD_TICK_AUDIENCE") or "").strip()
    if tick:
        candidates.append(tick)
    return tuple(dict.fromkeys(c for c in candidates if c))


#: Test seam. Resolved at call time, like ``scheduler_identity``'s own verifier, so
#: a test that substitutes it is really substituting it.
identity_verifier: Optional[Callable[[str, str], dict[str, Any]]] = None


def verify_hub_identity(scope: dict[str, Any]) -> SchedulerIdentity:
    """Raise ``SchedulerIdentityError`` unless the request carries a hub identity."""
    return verify_scheduler_request(
        authorization_header=_header(scope.get("headers") or (), "authorization"),
        audience=accepted_audiences(scope),
        allowed_emails=hub_caller_allowlist(),
        verifier=identity_verifier,
    )


class PodIngressPolicy:
    """Pure ASGI: the app surface passes, the machine wall verifies, the rest is 404."""

    def __init__(self, app: Any) -> None:
        self._app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        kind = scope.get("type")
        if kind not in {"http", "websocket"}:
            await self._app(scope, receive, send)
            return
        path = str(scope.get("path") or "")
        if is_app_surface(path):
            await self._app(scope, receive, send)
            return
        try:
            identity = verify_hub_identity(scope)
        except SchedulerIdentityError as exc:
            logger.info("pod_ingress.walled path=%s reason=%s", path, exc.reason)
            await self._refuse(scope, send)
            return
        scope.setdefault("state", {})["hub_identity"] = identity
        await self._app(scope, receive, send)

    @staticmethod
    async def _refuse(scope: dict[str, Any], send: Any) -> None:
        if scope.get("type") == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": "not found"})
            return
        await send(
            {
                "type": "http.response.start",
                "status": 404,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(_NOT_FOUND)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": _NOT_FOUND})


__all__ = [
    "APP_SURFACE_EXACT",
    "APP_SURFACE_PREFIXES",
    "PodIngressPolicy",
    "accepted_audiences",
    "hub_caller_allowlist",
    "identity_verifier",
    "is_app_surface",
    "verify_hub_identity",
]
