from __future__ import annotations

import asyncio
import os
from dataclasses import replace
from typing import Any

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from scripts.ops.hosted_provider_account_identity import (
    CENTRAL_PROJECT,
    EXPECTED_OPERATOR,
    SOURCE_REVISION_PATTERN,
    InventorySnapshot,
    OperatorRefused,
    _attempt,
    _creation_identity,
    _creation_recovery_ready,
    _owner_hash,
    _safe_result,
    _service_matches,
    require_reviewed_placement,
)

"""Lifecycle dispatch for already reviewed hosted placement records."""


async def perform_action(
    runtime: Any,
    action: str,
    placement: dict[str, Any],
    *,
    reviewed_sha256: str,
    inventory_snapshot: InventorySnapshot | None = None,
) -> dict[str, Any]:
    selected = str(placement.get("hushhId") or "")
    fresh = inventory_snapshot or await runtime.inventory()
    if fresh.unresolved or fresh.sha256 != reviewed_sha256:
        raise OperatorRefused("identity changed immediately before lifecycle dispatch")
    current = require_reviewed_placement(fresh, hushh_id=selected)
    record = (fresh.records or {}).get(selected)
    row = (record or {}).get("registryRow")
    owner = (record or {}).get("ownerId")
    authority_row = (record or {}).get("authorityRow")
    if not isinstance(row, dict) or not isinstance(owner, str) or not owner:
        raise OperatorRefused("retained registry owner is unavailable")
    if row.get("status") == "suspended" and action != "remove":
        raise OperatorRefused("suspended placements only continue through retained erasure")
    if current.get("tombstoneState", {}).get("state") == "current_erasure" and action != "remove":
        raise OperatorRefused(
            "pending deletion tombstone only permits retained erasure continuation"
        )
    _require_active_native_service(current, action)
    phase = current.get("transitionPhase")
    if phase in {"intent", "unknown"}:
        if action != "resume":
            raise OperatorRefused("unresolved provider account transition blocks this action")
        return _safe_result(await runtime.transition_factory().resume(owner_id=owner))
    if action == "associate-account":
        if phase != "none":
            raise OperatorRefused("provider account transition already has evidence")
        await runtime._require_named_operator(EXPECTED_OPERATOR)
        return _safe_result(await runtime.transition_factory().start(owner_id=owner))
    if action == "resume":
        if _creation_recovery_ready(authority_row):
            return await runtime._resume_existing_creation(owner_id=owner, row=row, record=record)
        raise OperatorRefused("no retained transition or reconcilable existing creation")
    if action == "remove":
        return await runtime._remove_through_retained_erasure(owner_id=owner, row=row)
    raise OperatorRefused("unsupported lifecycle action")


def _require_active_native_service(current: dict[str, Any], action: str) -> None:
    if action not in {"associate-account", "resume"}:
        return
    if (
        current.get("nativeProjectState") != "active"
        or current.get("nativeServiceState") != "verified"
    ):
        raise OperatorRefused("provider transition requires the exact active native service")


"""Safe acknowledgement recovery for an existing retained hosted creation."""


async def resume_existing_creation(
    runtime: Any, *, owner_id: str, row: dict[str, Any], record: dict[str, Any]
) -> dict[str, Any]:
    attempt, admission, spec, service = await _prepare_existing_creation(
        runtime, owner_id=owner_id, row=row, record=record
    )
    spec = _attach_acknowledgement(runtime, owner_id, attempt, admission, spec)
    await _require_current_admission(runtime, owner_id, attempt, admission)
    await _reconcile_existing_service(spec, service)
    return {"status": "existing_creation_acknowledged", "attemptId": attempt["attemptId"]}


async def _prepare_existing_creation(
    runtime: Any, *, owner_id: str, row: dict[str, Any], record: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any], Any, dict[str, Any]]:
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.hosted_gcp_admission import deployment_from_reservation

    attempt, admission, assignment = _retained_creation(row)
    source_revision = _installed_source_revision(admission)
    _validate_assignment(owner_id, row, assignment)
    await _require_same_registry_row(runtime, owner_id, row)
    service = _find_exact_service(record, row)
    hub_principal = _hub_principal(assignment)
    spec = _create_recovery_spec(
        PodSpec, row, attempt, admission, assignment, hub_principal, source_revision
    )
    deployment = deployment_from_reservation(
        spec, attempt, release=_release(admission, source_revision), hub_principal=hub_principal
    )
    return attempt, admission, replace(spec, private_gcp_deployment=deployment), service


def _retained_creation(
    row: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    attempt = _attempt(row)
    creation = _creation_identity(row)
    if not isinstance(attempt, dict) or not isinstance(creation, dict):
        raise OperatorRefused("retained creation authority is unavailable")
    admission = attempt.get("hostedAdmission")
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    if not isinstance(admission, dict) or not isinstance(assignment, dict):
        raise OperatorRefused("retained creation admission is unavailable")
    return attempt, admission, assignment


def _installed_source_revision(admission: dict[str, Any]) -> str:
    revision = str(os.getenv("HUSHH_DEPLOY_SHA") or "").strip().lower()
    if (
        not SOURCE_REVISION_PATTERN.fullmatch(revision)
        or admission.get("sourceRevision") != revision
    ):
        raise OperatorRefused("installed control-plane source revision differs from admission")
    return revision


def _validate_assignment(owner_id: str, row: dict[str, Any], assignment: dict[str, Any]) -> None:
    expected = PLACEMENTS.get(row.get("hushh_id"))
    if (
        expected is None
        or assignment.get("ownerHash") != _owner_hash(owner_id)
        or assignment.get("project") != expected["projectId"]
    ):
        raise OperatorRefused("retained creation placement differs")


async def _require_same_registry_row(runtime: Any, owner_id: str, row: dict[str, Any]) -> None:
    current = await runtime.registry.get(owner_id)
    if not isinstance(current, dict) or current != row:
        raise OperatorRefused("registry row changed before existing-create recovery")


def _find_exact_service(record: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    expected = PLACEMENTS[row["hushh_id"]]
    for service in record.get("services") or []:
        if _service_matches(service, row=row, expected=expected):
            return service
    raise OperatorRefused("existing exact service is absent; create is not permitted")


def _hub_principal(assignment: dict[str, Any]) -> str:
    federation = assignment.get("bootstrapContract", {}).get("plan", {}).get("federation", {})
    principal = federation.get("granted_to") if isinstance(federation, dict) else None
    if not isinstance(principal, str) or not principal:
        raise OperatorRefused("retained hub principal is unavailable")
    return principal


def _release(admission: dict[str, Any], source_revision: str) -> dict[str, str]:
    return {
        "sourceRevision": source_revision,
        "image": f"gcr.io/{CENTRAL_PROJECT}/consent-protocol-pod@{admission.get('imageDigest')}",
    }


def _create_recovery_spec(
    pod_spec_type: Any,
    row: dict[str, Any],
    attempt: dict[str, Any],
    admission: dict[str, Any],
    assignment: dict[str, Any],
    hub_principal: str,
    source_revision: str,
) -> Any:
    del admission, hub_principal, source_revision
    expected = PLACEMENTS[row["hushh_id"]]
    return pod_spec_type(
        hushh_id=row["hushh_id"],
        provision_attempt_id=attempt.get("attemptId"),
        expected_service_uid=expected["serviceUid"],
        deployment_target="gcp",
        region=assignment.get("region"),
        model_credential_mode="fleet_adc",
    )


def _attach_acknowledgement(
    runtime: Any,
    owner_id: str,
    attempt: dict[str, Any],
    admission: dict[str, Any],
    spec: Any,
) -> Any:
    loop = asyncio.get_running_loop()

    def publish(receipt: dict[str, Any]) -> None:
        future = asyncio.run_coroutine_threadsafe(
            runtime.registry.publish_provision(
                user_id=owner_id,
                attempt_id=attempt["attemptId"],
                expected_phase="host_requested",
                next_phase="host_requested",
                evidence={"creationAcknowledgement": receipt},
            ),
            loop,
        )
        if future.result(timeout=30) is not True:
            raise OperatorRefused("existing creation acknowledgement CAS refused")

    return replace(spec, on_provision_ack=publish)


async def _require_current_admission(
    runtime: Any, owner_id: str, attempt: dict[str, Any], admission: dict[str, Any]
) -> None:
    observation = attempt.get("evidence", {}).get("reserved", {}).get("projectObservation")
    if not await runtime.registry.hosted_execution_current(
        purpose="provision",
        owner_id=owner_id,
        attempt_id=attempt["attemptId"],
        admission=admission,
        project_observation=observation,
    ):
        raise OperatorRefused("hosted create recovery admission is no longer current")


async def _reconcile_existing_service(spec: Any, service: dict[str, Any]) -> None:
    from hushh_mcp.services.hosted_provision_recovery import reconcile_existing_creation

    class ExistingBackend:
        backend_id = "gcp"

    await reconcile_existing_creation(ExistingBackend(), spec, service)


"""Continuation through existing retained hosted erasure services."""


async def remove_through_retained_erasure(
    runtime: Any, *, owner_id: str, row: dict[str, Any]
) -> dict[str, Any]:
    erasure, actor = _retained_reservation(owner_id, row)
    operator = await runtime._require_named_operator(actor)
    service = RetainedManagedErasure(
        registry=runtime.registry,
        actor=actor,
        token=operator.token,
        session=runtime.session,
    )
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )

    lifecycle = PersonalAgentProvisioningService(registry=runtime.registry, managed_erasure=service)
    result = await lifecycle.deprovision(
        user_id=owner_id, expected_erasure_attempt=erasure["attemptId"]
    )
    return _safe_result(result)


def _retained_reservation(owner_id: str, row: dict[str, Any]) -> tuple[dict[str, Any], str]:
    erasure = (row.get("backend_metadata") or {}).get("erasure")
    if (
        row.get("status") != "suspended"
        or not isinstance(erasure, dict)
        or erasure.get("ownerId") != owner_id
        or not isinstance(erasure.get("attemptId"), str)
        or not isinstance(erasure.get("registrySnapshot"), dict)
    ):
        raise OperatorRefused("remove requires an existing retained erasure reservation")
    snapshot = erasure["registrySnapshot"]
    attempt = _attempt(snapshot)
    admission = attempt.get("hostedAdmission") if isinstance(attempt, dict) else None
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    contract = assignment.get("preparationContract") if isinstance(assignment, dict) else None
    actor = contract.get("operatorPrincipal") if isinstance(contract, dict) else None
    if actor != EXPECTED_OPERATOR:
        raise OperatorRefused("retained removal operator is not the named pilot principal")
    return erasure, actor


class RetainedManagedErasure:
    """Adapter from the existing erasure lifecycle to its guarded hosted steps."""

    def __init__(self, *, registry: Any, actor: str, token: str, session: Any) -> None:
        self.registry = registry
        self.actor = actor
        self.token = token
        self.session = session

    async def preparation(self, *, user_id: str, reservation: dict[str, Any]) -> None:
        from hushh_mcp.services.hosted_preparation_cleanup import cleanup_managed_preparation

        await cleanup_managed_preparation(
            self.registry,
            user_id=user_id,
            actor=self.actor,
            token=self.token,
            session=self.session,
        )

    async def prefix_abort(self, *, user_id: str, reservation: dict[str, Any]) -> None:
        from hushh_mcp.services.hosted_prefix_abort_operator import HostedPrefixAbortOperator

        await HostedPrefixAbortOperator(
            self.registry, actor=self.actor, token=self.token, session=self.session
        ).prefix_abort(user_id=user_id, reservation=reservation)

    async def model_grants(self, *, user_id: str, reservation: dict[str, Any]) -> None:
        from hushh_mcp.services.hosted_model_grant_cleanup import erase_managed_model_grants

        await erase_managed_model_grants(
            self.registry,
            user_id=user_id,
            actor=self.actor,
            token=self.token,
            session=self.session,
        )

    async def retirement(self, *, user_id: str, reservation: dict[str, Any]) -> None:
        from hushh_mcp.services.hosted_project_retirement import retire_managed_project

        await retire_managed_project(
            self.registry,
            user_id=user_id,
            actor=self.actor,
            token=self.token,
            session=self.session,
        )


class NamedGcloudOperatorCredentials:
    """Fetch the explicitly named operator token into memory only.

    The subprocess receives no token argument. Stdout is captured, never logged,
    and C2 verifies the resulting bearer token against Google's userinfo endpoint
    before persisting any intent or issuing a provider billing request.
    """

    def __init__(self) -> None:
        import os
        import shutil

        self._account = EXPECTED_OPERATOR.removeprefix("user:")
        configured = os.getenv("HUSHH_GCLOUD_EXECUTABLE")
        found = configured or shutil.which("gcloud")
        self._binary = os.path.realpath(found) if found and os.path.isabs(found) else None
        self.token: str | None = None
        self.valid = False

    def refresh(self, request: Any = None) -> None:
        import os
        import re
        import subprocess

        del request
        if (
            self._binary is None
            or not os.path.isabs(self._binary)
            or not os.path.isfile(self._binary)
            or not os.access(self._binary, os.X_OK)
        ):
            raise OperatorRefused("named gcloud account credential is unavailable")
        try:
            completed = subprocess.run(  # noqa: S603 -- fixed absolute gcloud command, no shell
                [
                    self._binary,
                    "auth",
                    "print-access-token",
                    f"--account={self._account}",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
                shell=False,
            )
        except Exception:
            self.token = None
            self.valid = False
            raise OperatorRefused(
                "named gcloud account could not provide an operator token"
            ) from None
        token = completed.stdout.strip()
        if completed.returncode != 0 or not re.fullmatch(r"[\x21-\x7e]{20,8192}", token):
            self.token = None
            self.valid = False
            raise OperatorRefused("named gcloud account could not provide an operator token")
        self.token = token
        self.valid = True
