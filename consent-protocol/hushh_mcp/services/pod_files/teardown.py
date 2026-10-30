"""Reconcile captured Files resources inside the existing owner erasure reservation."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

from hushh_mcp.services.byoc_substrate import _service_account_creation_identity
from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError
from hushh_mcp.services.pod_files.provisioning import queue_creation_observation


def reconcile_resource(
    *,
    token: str,
    project: str,
    region: str,
    observation: dict[str, Any],
    state: dict[str, Any],
    retain_receipt: Callable[[str, dict[str, Any]], bool],
    session: Any = None,
) -> None:
    """Quiesce, delete, then read back; uncertain mutations require reconciliation.

    Worker requests target immutable uniqueId. Cloud Tasks exposes no incarnation
    token, so a retained creation acknowledgement and exclusive owner lifecycle
    admission are required, and an unacknowledged DELETE is never replayed.
    """
    from urllib.parse import quote

    kind, rid = observation.get("type"), observation.get("id")
    if not isinstance(rid, str) or observation.get("disposition") != "created":
        raise SubstrateDeleteError("Files creation evidence unavailable")
    identity = observation.get("identity")
    if kind == "cloud_tasks_queue":
        name = f"projects/{project}/locations/{region}/queues/{rid}"
        if identity != queue_creation_observation(identity, name) or identity is None:
            raise SubstrateDeleteError("Files queue creation evidence unverified")
        url = f"https://cloudtasks.googleapis.com/v2/{quote(name, safe='/')}"
        quiesce = ":pause"
    elif kind == "service_account":
        if (
            identity != _service_account_creation_identity(identity, rid)
            or identity is None
            or identity["projectId"] != project
        ):
            raise SubstrateDeleteError("Files worker creation evidence unverified")
        url = f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{identity['uniqueId']}"
        quiesce = ":disable"
    else:
        raise SubstrateDeleteError("unsupported Files resource")
    base = {"resourceObservation": deepcopy(observation)}
    stages = {
        "admission": "admitted",
        "quiescence": "quiesced",
        "acknowledgement": "acknowledged",
        "deletion": "absent",
    }
    if state and (
        set(state) - set(stages)
        or any(
            state.get(stage) != {**base, "status": status}
            for stage, status in stages.items()
            if stage in state
        )
    ):
        raise SubstrateDeleteError("Files recovery evidence invalid")
    if state and not all(
        stage in state for stage in ("admission", "quiescence", "acknowledgement")
    ):
        raise SubstrateDeleteError("Files mutation acknowledgement unresolved")
    if session is None:
        import requests

        session = requests
    headers = {"Authorization": f"Bearer {token}"}

    def retain(stage: str) -> None:
        receipt = {**base, "status": stages[stage]}
        if retain_receipt(stage, deepcopy(receipt)) is not True:
            raise SubstrateDeleteError("Files receipt retention unconfirmed")
        state[stage] = receipt

    def matches(body: dict[str, Any]) -> bool:
        if kind == "cloud_tasks_queue":
            return queue_creation_observation(body, identity["name"]) == identity
        return _service_account_creation_identity(body, rid) == identity

    if not state:
        observed = session.get(url, headers=headers, timeout=30, allow_redirects=False)
        if observed.status_code != 200 or not matches(observed.json()):
            raise SubstrateDeleteError("Files resource relationship unverified")
        retain("admission")
        response = session.post(
            url + quiesce, headers=headers, json={}, timeout=30, allow_redirects=False
        )
        if response.status_code != 200:
            raise SubstrateDeleteError("Files quiescence unconfirmed")
        observed = session.get(url, headers=headers, timeout=30, allow_redirects=False)
        body = observed.json() if observed.status_code == 200 else {}
        if not matches(body) or (
            body.get("state") != "PAUSED"
            if kind == "cloud_tasks_queue"
            else body.get("disabled") is not True
        ):
            raise SubstrateDeleteError("Files quiescence readback unconfirmed")
        retain("quiescence")
        response = session.delete(url, headers=headers, timeout=30, allow_redirects=False)
        if response.status_code != 200 or response.json() != {}:
            raise SubstrateDeleteError("Files deletion acknowledgement unconfirmed")
        retain("acknowledgement")
    absent = session.get(url, headers=headers, timeout=30, allow_redirects=False)
    if absent.status_code != 404:
        raise SubstrateDeleteError("Files resource absence unverified")
    retain("deletion")
