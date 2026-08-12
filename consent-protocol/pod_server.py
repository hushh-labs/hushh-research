"""Slim pod ASGI app — runs ONLY the agent + its storage/enforcement surface.

This is the per-user **pod** entrypoint — the "Docker image that only runs the
agent and its storage." It is deliberately **not** the full backend:

- **Central at Hushh (never mounted here):** the governing consent *control plane*
  (token issuance, the audit-DB authority, developer/admin APIs) and every
  unrelated surface — RIA, email, marketplace, account, IAM, PKM admin, and
  login / WebAuthn. Those stay with the fleet hub.
- **In the pod (mounted here):** the agent runtime (Agent One orchestrating its
  specialists) reachable over the **A2A** endpoint; the consent **enforcement**
  path at the pod's own door (validate the HCT/consent token, revocation check,
  owner-verified pod-access receipt — *enforcement, not issuance*); the pod's own
  **health**; and the versioned **prompt** it hydrates at runtime.

Fleet-wide workers (the consent NOTIFY→FCM listener, Gmail renewal, the revocation
sweep) are **never registered** by this app — it simply does not add them — so a
fleet of pods cannot duplicate the hub's side effects. ``HUSSH_POD_MODE`` is also
asserted for any shared code that reads it.

Run: ``gunicorn pod_server:app`` (see ``Dockerfile.pod``). The physical image can
be slimmed further (trimmed dependency set) as a follow-up; this entrypoint fixes
the *runtime surface* — the security-relevant property — now.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

# A pod is a pod: assert pod-mode BEFORE importing app code that may read it.
os.environ.setdefault("HUSSH_POD_MODE", "1")

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from slowapi import _rate_limit_exceeded_handler  # noqa: E402
from slowapi.errors import RateLimitExceeded  # noqa: E402

from api.middlewares.observability import (  # noqa: E402
    configure_opentelemetry,
    observability_middleware,
)
from api.middlewares.rate_limit import limiter  # noqa: E402
from api.routes import health  # noqa: E402
from api.routes.one.a2a import router as a2a_router  # noqa: E402
from api.routes.one.a2a import well_known_router as a2a_well_known_router  # noqa: E402
from api.routes.one.agent_prompt import router as agent_prompt_router  # noqa: E402
from api.routes.one.pod_turn import router as pod_turn_router  # noqa: E402
from db.connection import DatabaseUnavailableError  # noqa: E402
from db.db_client import DatabaseExecutionError  # noqa: E402
from hushh_mcp.runtime_settings import (  # noqa: E402
    pod_heartbeat_interval_seconds,
    pod_mode,
)
from hushh_mcp.services.pod_hub_client import (  # noqa: E402
    PodHubClient,
    PodHubUnavailable,
    hub_base_url,
)
from hushh_mcp.services.pod_self_registration import (  # noqa: E402
    pod_key_is_durable,
    pod_keypair,
    pod_public_key_payload,
)

# MAKE THE POD SPEAK. Without these two lines a pod is silent, and a silent pod is
# an undebuggable one.
#
# `pod_server` never configured logging at all. Gunicorn only configures the root
# logger when `logconfig*` is set, which `Dockerfile.pod` does not set, and
# `UvicornWorker` passes `log_config: None`. So the root logger stayed at Python's
# default WARNING with only `lastResort` attached, and EVERY `logger.info(...)` in
# the pod was dropped before it was formatted -- the whole `request.summary` stream,
# `pod.startup`, `pod.heartbeat_started`, `pod_turn.consent_refused`, and both
# `pod_hub_auth.accepted` lines. An operator watching a pod saw warnings and errors
# and nothing else, so a pod that was working and a pod that was never called looked
# identical.
#
# The redaction filter lands in the SAME change, never after. The pod logs its own
# HusshID (`pod_hub_auth.accepted asserted_agent_id=...`), and the hub is only
# incidentally safe because `install_sensitive_log_filter` catches the HusshID shape.
# Turning the pod's log stream on without the filter would convert silence into a
# per-pod stream of raw owner identifiers -- trading one defect for a worse one.
from mcp_modules.log_redaction import (  # noqa: E402,PLC0415
    install_sensitive_log_filter as _install_pod_log_redaction,
)

logging.basicConfig(level=logging.INFO)
_install_pod_log_redaction()

logger = logging.getLogger(__name__)

# The pod's ALLOWLISTED surface — the ONLY routers a pod mounts. Anything not in
# this tuple (consent issuance, developer/admin, RIA, email, marketplace, account,
# IAM, PKM admin, login/WebAuthn) is central-plane and intentionally absent.
_POD_ROUTERS = (
    health.router,
    a2a_well_known_router,
    a2a_router,
    agent_prompt_router,
    # The turn route: this is what makes a pod run Agent One rather than merely
    # host its prompt. Flag-gated off and pod-mode-only; see api/routes/one/pod_turn.py.
    pod_turn_router,
)

app = FastAPI(
    title="hussh One — sovereign pod",
    description="Per-user agent + storage. The consent authority stays central at Hushh.",
    version="pod-1",
)
# Telemetry, mounted from the hub's middleware rather than reimplemented. Until
# this line a pod emitted NO `request.summary` line and no trace, so a pod that was
# failing every request looked, from outside, exactly like a pod nobody had called
# -- and there is no way to tell those apart from silence.
#
# `_service_name()` reads `K_SERVICE` first, which Cloud Run sets to the pod's own
# service name, so every line a pod emits is already attributed to `one-pod-<id>`
# rather than to the hub. That is what makes a pod-scoped alert policy possible;
# the existing policies all filter `service_name="consent-protocol"` and therefore
# match no pod at all.
app.middleware("http")(observability_middleware)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]


@app.exception_handler(DatabaseUnavailableError)
async def _db_unavailable(_request: Request, _exc: DatabaseUnavailableError) -> JSONResponse:
    # The pod hits the DB only to VALIDATE consent (enforcement); a DB blip is a
    # clean 503, never a raw 500 that could leak internals.
    return JSONResponse(status_code=503, content={"detail": "database unavailable"})


@app.exception_handler(DatabaseExecutionError)
async def _db_exec_error(_request: Request, _exc: DatabaseExecutionError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": "database error"})


@app.exception_handler(PodHubUnavailable)
async def _hub_unavailable(_request: Request, _exc: PodHubUnavailable) -> JSONResponse:
    """A pod reads the data plane THROUGH the hub, so a hub outage is this pod's
    dependency outage -- the same shape as the DB handlers above, and for the same
    reason: 503 says "ask again", where an unhandled 500 both leaks a traceback and
    invites a caller to treat the failure as a permanent answer. Observed for real in
    hushh-pda-dev on 2026-08-04, where a hub that refused the pod surfaced as a raw 500.
    """
    return JSONResponse(status_code=503, content={"detail": "hub unavailable"})


for _router in _POD_ROUTERS:
    app.include_router(_router)

# Tracing, off unless OTEL_ENABLED is set. Every failure path inside is caught and
# logged, so a pod whose trace exporter cannot reach Cloud Trace still serves --
# telemetry must never be the reason a person's agent stops answering.
configure_opentelemetry(app)


def _mounted_paths() -> list[str]:
    """The routes this process actually serves, read off the app itself.

    NOT a hand-maintained literal, and the reason is two files away: ``/health``
    advertised a hardcoded ``["one","kai","nav","kyc"]`` roster, a live-validation
    document quoted that string as proof the fleet was running inside pods, and no
    Python anywhere loaded kyc's YAML. A capability list that cannot be wrong is
    worth less than no list at all, because people believe it.

    This one is derived, so a router that fails to mount disappears from the answer
    and a router added without touching this file appears in it.
    """
    seen: set[str] = set()
    for route in app.routes:
        path = str(getattr(route, "path", "") or "")
        if path and not path.startswith("/openapi"):
            seen.add(path)
    return sorted(seen)


@app.get("/pod/info", tags=["pod"])
def pod_info() -> dict:
    """Identify this process as a slim pod and report its mounted surface."""
    return {
        "role": "sovereign-pod",
        "podMode": pod_mode(),
        "hushhId": os.getenv("HUSSH_ID") or None,
        "spaceId": os.getenv("HUSSH_SPACE_ID") or None,
        "controlPlane": "central@hushh (consent issuance + audit not hosted here)",
        "mounts": _mounted_paths(),
    }


@app.get("/pod/public-key", tags=["pod"])
def pod_public_key() -> dict:
    """This pod's PUBLIC key, for the hub to record against this agent's row.

    Deliberately unauthenticated: a public key is public, and the hub reaches this
    at a URL it recorded itself when it created the service, so there is no caller
    identity to establish. Pods are ``internal`` ingress with no ``allUsers``
    binding, so nothing outside the project can reach it in any case.

    Serving the key is the pod's whole part in provisioning -- the hub decides
    whether to adopt it (see ``pod_key_collector``).
    """
    return {
        "hushhId": os.getenv("HUSSH_ID") or None,
        # Honesty marker for the hub and for storage layers: only a durable key
        # (mounted from a restart-surviving source the hub cannot read) may have
        # durable material wrapped to it. Ephemeral keys rotate on restart.
        "podKeyDurable": pod_key_is_durable(),
        **pod_public_key_payload(),
    }


@app.on_event("startup")
async def _pod_startup() -> None:
    # The HusshID is logged as a VALUE, not a presence bit. It is the opaque public
    # handle (personal_agent_identity_service) -- it is already this pod's Cloud Run
    # service name (`one-pod-<hushh_id>`) and its A2A route, so redacting it here
    # protected nothing and cost the only key that joins this pod's logs to the hub's
    # provisioning story. `space_id` stays a presence bit: it is not an address.
    logger.info(
        "pod.startup pod_mode=%s hushh_id=%s space_id_present=%s",
        pod_mode(),
        os.getenv("HUSSH_ID") or "<none>",
        bool(os.getenv("HUSSH_SPACE_ID")),
    )

    # Generate the keypair now rather than on the first request, so the key exists
    # before the hub can ask for it and two concurrent requests cannot race to
    # create two different ones.
    pod_keypair()

    _start_heartbeat_loop()


# -- heartbeat ---------------------------------------------------------------
#
# The pod tells the hub it is alive; the hub never polls the fleet. Polling would
# cost an authenticated round trip per pod per interval, and on the scale-to-zero
# tier the poll itself is what wakes the pod -- so the health check would keep the
# whole economy fleet running and bill for the privilege. A push costs one small
# request from a process that is already awake, and it makes silence meaningful:
# an idle economy pod simply stops beating, which is the truth about it.


async def _heartbeat_once(client: Any) -> bool:
    """Send one beat. Returns whether the hub recorded it. Never raises."""
    try:
        response = await asyncio.to_thread(client.post, "/api/one/pod/heartbeat")
    except PodHubUnavailable as exc:
        logger.info("pod.heartbeat_unavailable %s", type(exc).__name__)
        return False
    except Exception as exc:  # noqa: BLE001 - a heartbeat must never take the pod down
        logger.info("pod.heartbeat_failed %s", type(exc).__name__)
        return False
    status = getattr(response, "status_code", 0)
    if status != 200:
        # Logged, not raised. A 404 here means the hub has no registry row for this
        # HusshID -- this pod is an orphan -- and that is worth seeing in the pod's
        # own logs as well as the hub's, because the two halves get read by
        # different people.
        logger.warning("pod.heartbeat_rejected status=%s", status)
        return False
    return True


async def _heartbeat_loop(interval_seconds: int) -> None:
    """Beat forever. Every failure is swallowed deliberately.

    A pod whose heartbeat path is broken must keep SERVING -- the person's agent
    answering their questions matters more than the hub's view of it being current.
    Letting this task die would also be self-defeating: the pod would go silent, the
    hub would judge it unreachable, and auto-heal would restart a pod that was
    working fine.
    """
    client = PodHubClient()
    while True:
        await _heartbeat_once(client)
        await asyncio.sleep(interval_seconds)


def _start_heartbeat_loop() -> None:
    """Attach the heartbeat task, unless this pod has no hub to talk to."""
    if not hub_base_url():
        # Local/test runs have no hub. Beating into the void would log a failure
        # every interval and teach whoever reads those logs to ignore them.
        logger.info("pod.heartbeat_disabled reason=no_hub_base_url")
        return
    interval = pod_heartbeat_interval_seconds()
    try:
        asyncio.get_running_loop().create_task(_heartbeat_loop(interval))
    except RuntimeError:  # pragma: no cover - startup always has a loop
        logger.info("pod.heartbeat_no_event_loop")
        return
    logger.info("pod.heartbeat_started interval_seconds=%s", interval)
