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

import logging
import os

# A pod is a pod: assert pod-mode BEFORE importing app code that may read it.
os.environ.setdefault("HUSSH_POD_MODE", "1")

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from slowapi import _rate_limit_exceeded_handler  # noqa: E402
from slowapi.errors import RateLimitExceeded  # noqa: E402

from api.middlewares.rate_limit import limiter  # noqa: E402
from api.routes import health  # noqa: E402
from api.routes.one.a2a import router as a2a_router  # noqa: E402
from api.routes.one.a2a import well_known_router as a2a_well_known_router  # noqa: E402
from api.routes.one.agent_prompt import router as agent_prompt_router  # noqa: E402
from db.connection import DatabaseUnavailableError  # noqa: E402
from db.db_client import DatabaseExecutionError  # noqa: E402
from hushh_mcp.runtime_settings import pod_mode  # noqa: E402
from hushh_mcp.services.pod_hub_client import PodHubUnavailable  # noqa: E402
from hushh_mcp.services.pod_self_registration import (  # noqa: E402
    pod_key_is_durable,
    pod_keypair,
    pod_public_key_payload,
)

logger = logging.getLogger(__name__)

# The pod's ALLOWLISTED surface — the ONLY routers a pod mounts. Anything not in
# this tuple (consent issuance, developer/admin, RIA, email, marketplace, account,
# IAM, PKM admin, login/WebAuthn) is central-plane and intentionally absent.
_POD_ROUTERS = (health.router, a2a_well_known_router, a2a_router, agent_prompt_router)

app = FastAPI(
    title="hussh One — sovereign pod",
    description="Per-user agent + storage. The consent authority stays central at Hushh.",
    version="pod-1",
)
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


@app.get("/pod/info", tags=["pod"])
def pod_info() -> dict:
    """Identify this process as a slim pod and report its mounted surface."""
    return {
        "role": "sovereign-pod",
        "podMode": pod_mode(),
        "hushhId": os.getenv("HUSSH_ID") or None,
        "spaceId": os.getenv("HUSSH_SPACE_ID") or None,
        "controlPlane": "central@hushh (consent issuance + audit not hosted here)",
        "mounts": ["health", "a2a", "a2a-well-known", "agent-prompt", "public-key"],
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
    logger.info(
        "pod.startup pod_mode=%s hushh_id_present=%s space_id_present=%s",
        pod_mode(),
        bool(os.getenv("HUSSH_ID")),
        bool(os.getenv("HUSSH_SPACE_ID")),
    )

    # Generate the keypair now rather than on the first request, so the key exists
    # before the hub can ask for it and two concurrent requests cannot race to
    # create two different ones.
    pod_keypair()
