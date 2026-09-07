"""The concrete ends of the liveness seams: how to actually probe, and how to heal.

``pod_liveness_worker`` is written against injected callables so its policy is
testable without a cloud project. This module is what gets injected in production.
It is deliberately separate: everything here touches the network or the database,
and none of it decides anything.

The probe asks /health, not /pod/info
-------------------------------------
Cloud Run's Ready condition is a TCP connect by default, and gunicorn binds its
port before forking workers -- so a pod whose workers die on import reports Ready
AND ContainerHealthy while answering 503 to every request (observed in
hushh-pda-dev, 2026-08-04). Asking the pod's own ``/health`` over HTTP is the only
answer that means "this process is serving". ``/health/ready`` would be wrong here
for the opposite reason: readiness includes a database check and a pod holds no
database credential by design, so a perfectly healthy pod answers 503 to it.

The address always comes from the row the HUB wrote at service creation, never
from anything a caller supplied, so there is nothing to point the probe at.
"""

from __future__ import annotations

import logging
import secrets
from typing import Any, Optional

from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

_PROBE_TIMEOUT_SECONDS = 8.0


def pod_url(row: dict) -> Optional[str]:
    """The pod's URL as the hub recorded it, or None when it has no address yet."""
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, dict):
        return None
    url = str(metadata.get("url") or "").strip().rstrip("/")
    return url if url.startswith("https://") else None


def _identity_token(audience: str) -> Optional[str]:
    """A hub-minted ID token for this pod. The hub calls the pod as itself.

    No shared secret crosses the boundary: the pod's service account grants
    run.invoker to the hub runtime, so each authenticates the other without either
    holding the other's key.
    """
    try:
        import google.auth.transport.requests  # noqa: PLC0415
        import google.oauth2.id_token  # noqa: PLC0415

        request = google.auth.transport.requests.Request()
        token = google.oauth2.id_token.fetch_id_token(request, audience)
        return str(token) if token else None
    except Exception as exc:  # noqa: BLE001 - an unauthenticated probe is simply refused
        logger.info("pod_liveness.identity_token_failed %s", type(exc).__name__)
        return None


async def probe_pod(row: dict, *, session: Any = None) -> bool:
    """Does this pod actually serve right now? Confirmation, not inference.

    Returns False for "no address yet" as well as for a refused or failed request:
    a pod the hub cannot reach is not confirmed alive, whatever the reason. The
    caller (the sweep) only ever uses a False to increment a streak, never to heal
    on its own, so a conservative False costs one more pass rather than a restart.
    """
    url = pod_url(row)
    if url is None:
        return False

    client: Any = session
    if client is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        client = requests

    token = await run_in_threadpool(_identity_token, url)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        response = await run_in_threadpool(
            lambda: client.get(f"{url}/health", headers=headers, timeout=_PROBE_TIMEOUT_SECONDS)
        )
    except Exception as exc:  # noqa: BLE001 - unreachable is a False, never a raise
        logger.info("pod_liveness.probe_unreachable %s", type(exc).__name__)
        return False
    return getattr(response, "status_code", 0) == 200


async def wake_pod(row: dict, *, session: Any = None) -> bool:
    """Wake a scale-to-zero pod ON DEMAND, and only on demand.

    Identical mechanics to :func:`probe_pod` -- an inbound request is what scales a
    Cloud Run service off zero, so probing and waking are the same act. They are
    two named functions because the INTENT differs, and the intent is the whole
    safety property: the sweep must never call this, because a scheduled wake would
    keep the economy fleet permanently awake and bill for it. A wake is legitimate
    only when a person is actually asking for their agent.

    Keeping the names distinct means a future caller has to choose the one that
    says "I am waking a sleeping pod because someone asked", rather than reaching
    for a generic probe and silently turning the sweep into a fleet-wide alarm clock.
    """
    logger.info("pod_liveness.wake_on_demand user_id=%s", row.get("user_id"))
    return await probe_pod(row, session=session)


async def heal_pod(row: dict, *, client: Any = None, registry: Any = None) -> bool:
    """Restart a confirmed-dead pod by replacing its service. Never re-provisions.

    Three steps, in this order:

    1. ``replace_service`` (PUT) with a fresh nonce. The nonce is what forces Cloud
       Run to roll a NEW revision: a PUT whose body is byte-identical to the live
       spec is a no-op, so without it "healing" a crash-looping pod would return
       success and change nothing -- a 200 on an empty page.
    2. The service keeps its name and URL, so the address the hub recorded stays
       valid and nothing downstream has to be told about the restart.
    3. ``refresh_pod_key``. A restarted pod regenerates an EPHEMERAL keypair (only a
       durable, restart-surviving key is exempt), so the public key in the registry
       is stale the moment the new revision boots. Leaving it would mean the hub
       wrapping material to a key the pod no longer holds -- the pod would come back
       "healthy" and be unable to read its own holdings.

    What this must never be: ``deprovision()`` + ``provision()``. That path revokes
    the standing pkm.read grant, tombstones the HusshID and deletes the row, and the
    re-provision mints a NEW HusshID. The person's agent identity -- what their
    consent receipts, their A2A address and their pod's published key all point at --
    would silently become a different agent because a health check timed out.
    """
    name = str(row.get("external_agent_id") or "").strip()
    if not name:
        logger.warning("pod_liveness.heal_skipped reason=no_external_agent_id")
        return False

    run_client = client
    if run_client is None:
        from hushh_mcp.services.gcp_run_client import GcpRunClient  # noqa: PLC0415

        # `GcpRunClient()` with no arguments raises TypeError -- `project` and
        # `region` are required keyword-only. Because that call sat OUTSIDE the try
        # below, the error propagated straight out of heal_pod into the caller's
        # generic per-row handler, so this function has never once healed a pod. It
        # looked reachable in every review; it was reachable and immediately fatal.
        #
        # The row already knows where its own pod lives: `_execute` writes project
        # and region into `backend_metadata` at provision time. Reading them here
        # keeps healing bound to the pod's ACTUAL project rather than to whatever
        # the process ambient config happens to be -- which matters now that those
        # two are known to differ on the dev lane.
        metadata = row.get("backend_metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        project = str(metadata.get("project") or "").strip()
        region = str(metadata.get("region") or "").strip()
        if not project or not region:
            logger.warning(
                "pod_liveness.heal_skipped service=%s reason=no_backend_location "
                "project=%r region=%r",
                name,
                project,
                region,
            )
            return False
        run_client = GcpRunClient(project=project, region=region)

    try:
        current = await run_in_threadpool(run_client.get_service, name)
        if current is None:
            # Nothing to replace. A missing service is a provisioning problem, not a
            # liveness one, and creating it here would turn a restart into a silent
            # provision -- exactly the conflation replace_service refuses to make.
            logger.warning("pod_liveness.heal_skipped service=%s reason=no_such_service", name)
            return False
        await run_in_threadpool(
            lambda: run_client.replace_service(
                name,
                current,
                # Fresh every heal. Reusing one would make the second PUT identical
                # to the live spec and therefore a no-op.
                revision_nonce=secrets.token_hex(8),
            )
        )
    except Exception as exc:  # noqa: BLE001 - a failed heal is reported, never raised
        logger.warning("pod_liveness.heal_failed service=%s %s", name, type(exc).__name__)
        return False

    # Best-effort: the restart itself succeeded, and reporting failure because the
    # key re-pull did not would make the sweep re-heal a pod that is already coming
    # back up. A stale key is re-collected on the next pass either way.
    try:
        from hushh_mcp.services.pod_key_collector import refresh_pod_key  # noqa: PLC0415

        await refresh_pod_key(row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_liveness.key_refresh_failed service=%s %s", name, type(exc).__name__)

    logger.warning("pod_liveness.healed service=%s", name)
    return True


def build_liveness_seams(registry: Any = None) -> dict:
    """The production wiring for ``run_liveness_pass``, in one place.

    A caller that assembles these by hand is a caller that can quietly pass
    :func:`wake_pod` as the sweep's probe.
    """
    if registry is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        registry = PersonalAgentRegistryRepo()

    return {
        "fetch_candidates": registry.fetch_liveness_candidates,
        "probe_pod": probe_pod,
        "heal_pod": heal_pod,
        "record_state": registry.set_health_state,
    }
