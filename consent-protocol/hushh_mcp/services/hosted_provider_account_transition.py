"""One retained Dev billing transition with observation-only recovery."""

from __future__ import annotations

import asyncio
import hashlib
import re
from datetime import datetime, timezone
from typing import Any, Callable

from hushh_mcp.services.gcp_project_billing import (
    link_provider_account_transition_once,
    observe_provider_account_transition_billing,
)
from hushh_mcp.services.hosted_operator_identity import VerifiedOperator, verify_operator
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

ACTOR_PRINCIPAL = "user:kushaltrivedi97@gmail.com"
OLD_BILLING_ACCOUNT = "billingAccounts/014D7F-FD970D-D2459E"
TARGET_BILLING_ACCOUNT = "billingAccounts/013848-8258FA-2D068F"
IMAGE_DIGEST = "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
_PROJECT_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_PROJECT_NUMBER_PATTERN = re.compile(r"^[1-9][0-9]{0,19}$")
_SUBJECT_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,255}$")

PLACEMENTS: dict[str, dict[str, Any]] = {
    "ha1_t6cqxavpt6sumlllpfcjrwkh4fztw5zq": {
        "hushhId": "ha1_t6cqxavpt6sumlllpfcjrwkh4fztw5zq",
        "projectId": "hussh-hp-7da5778b-261027a",
        "projectNumber": "1010592650891",
        "placementEpoch": 0,
        "attemptId": "95af9d1fdab94601a1e45554e4774fd3",
        "operationId": "777fe0a3-eaa2-42b3-97d2-3b6549a20290",
        "serviceUid": "fec811ba-2456-495d-ab66-a0d926077ae1",
        "runtimePrincipal": "one-pod-ha1-t6cqxavpt-rkntchve@hussh-hp-7da5778b-261027a.iam.gserviceaccount.com",
    },
    "ha1_sdhll3ua5kg4o6cmo2imyijcmygnwzqh": {
        "hushhId": "ha1_sdhll3ua5kg4o6cmo2imyijcmygnwzqh",
        "projectId": "hussh-hp-a3a6730e-261027b",
        "projectNumber": "349132050484",
        "placementEpoch": 0,
        "attemptId": "67ce0564b4b541a69abb31b336e51352",
        "operationId": "9df62f66-f271-491d-ab34-406823292f5d",
        "serviceUid": "e14040de-505a-4fc6-9a4a-e391ea1d6026",
        "runtimePrincipal": "one-pod-ha1-sdhll3ua5-rqghnwhy@hussh-hp-a3a6730e-261027b.iam.gserviceaccount.com",
    },
}


class HostedProviderAccountTransition:
    """Move one approved placement's billing account without replaying a PUT."""

    def __init__(
        self,
        registry: Any,
        *,
        credentials: Any,
        session: Any,
        journal: HostedPodJournal | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._registry = registry
        self._credentials = credentials
        self._session = session
        self._journal = journal or HostedPodJournal(registry._db())
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    async def start(self, *, owner_id: str) -> dict[str, Any]:
        """Persist one intent, then allow the only transition PUT in this service."""
        row = await self._row(owner_id)
        placement, attempt, creation = _placement_for_row(row, owner_id)
        if "providerAccountTransition" in attempt:
            raise ProvisionReconciliationRequired("Provider account transition already exists")
        operator = await self._verify_actor()
        intent = _new_intent(row, placement, attempt, creation, operator, self._clock())
        try:
            admitted = await self._journal.record_provider_account_transition_intent(
                owner_id=owner_id, attempt_id=placement["attemptId"], intent=intent
            )
        except Exception as exc:  # noqa: BLE001 - journal failure must stop provider work
            raise ProvisionReconciliationRequired(
                "Provider account transition intent could not be retained"
            ) from exc
        if admitted is not True:
            raise ProvisionReconciliationRequired("Provider account transition intent was refused")
        return await self._observe_and_maybe_link(
            placement=placement,
            creation=creation,
            intent={**intent, "minimumSourceRevision": _installed_source_revision()},
            operator=operator,
            expected_generation=1,
            expected_phase="intent",
            allow_put=True,
        )

    async def resume(self, *, owner_id: str) -> dict[str, Any]:
        """Observe a retained intent/outcome; this method never calls PUT."""
        row = await self._row(owner_id)
        placement, attempt, creation = _placement_for_row(row, owner_id)
        transition = attempt.get("providerAccountTransition")
        if not isinstance(transition, dict):
            raise ProvisionReconciliationRequired("Provider account transition is unavailable")
        phase, generation = transition.get("phase"), transition.get("generation")
        intent = transition.get("intent")
        if phase == "settled":
            return {"phase": "settled", "generation": generation}
        if phase not in {"intent", "unknown"} or type(generation) is not int:
            raise ProvisionReconciliationRequired("Provider account transition is malformed")
        if generation != (1 if phase == "intent" else 2) or not isinstance(intent, dict):
            raise ProvisionReconciliationRequired("Provider account transition is malformed")
        _validate_retained_intent(intent, placement, row)
        operator = await self._verify_actor()
        if (
            operator.principal != intent.get("actorPrincipal")
            or operator.subject != intent.get("actorVerification", {}).get("subject")
            or operator.email != intent.get("actorVerification", {}).get("email")
        ):
            raise ProvisionReconciliationRequired("Provider transition actor differs from intent")
        return await self._observe_and_maybe_link(
            placement=placement,
            creation=creation,
            intent=intent,
            operator=operator,
            expected_generation=generation,
            expected_phase=phase,
            allow_put=False,
        )

    async def _row(self, owner_id: str) -> dict[str, Any]:
        if not isinstance(owner_id, str) or not owner_id:
            raise ProvisionReconciliationRequired("Provider account transition owner is invalid")
        row = await self._registry.get(owner_id)
        if not isinstance(row, dict):
            raise ProvisionReconciliationRequired(
                "Provider account transition owner is unavailable"
            )
        return row

    async def _verify_actor(self) -> VerifiedOperator:
        try:
            operator = await asyncio.to_thread(
                verify_operator,
                self._credentials,
                self._session,
                expected=ACTOR_PRINCIPAL,
            )
        except Exception as exc:  # noqa: BLE001 - no provider work without named actor proof
            raise ProvisionReconciliationRequired(
                "Provider account transition actor could not be verified"
            ) from exc
        if (
            operator.principal != ACTOR_PRINCIPAL
            or operator.email != ACTOR_PRINCIPAL.removeprefix("user:")
            or operator.email_verified is not True
            or not _SUBJECT_PATTERN.fullmatch(operator.subject)
        ):
            raise ProvisionReconciliationRequired("Provider account transition actor is invalid")
        return operator

    async def _observe_and_maybe_link(
        self,
        *,
        placement: dict[str, Any],
        creation: dict[str, Any],
        intent: dict[str, Any],
        operator: VerifiedOperator,
        expected_generation: int,
        expected_phase: str,
        allow_put: bool,
    ) -> dict[str, Any]:
        try:
            before = await self._observe(placement, creation, operator.token)
        except Exception as exc:  # noqa: BLE001 - uncertain read leaves a retained outcome
            return await self._retain_unknown(
                intent, operator, expected_generation, expected_phase, allow_put, exc
            )

        target = intent["targetBillingAccount"]
        old = intent["oldBillingAccount"]
        if before["billingAccountName"] == target and before["billingEnabled"] is True:
            # A repeated native read brackets settlement; it still performs no PUT.
            try:
                after = await self._observe(placement, creation, operator.token)
            except Exception as exc:  # noqa: BLE001 - preserve the unresolved state
                return await self._retain_unknown(
                    intent, operator, expected_generation, expected_phase, allow_put, exc
                )
            if after["billingAccountName"] == target and after["billingEnabled"] is True:
                return await self._settle(
                    intent, operator, placement, after, expected_generation, expected_phase
                )

        if (
            before
            == {
                "projectId": placement["projectId"],
                "billingAccountName": old,
                "billingEnabled": True,
            }
            and allow_put
        ):
            try:
                await asyncio.to_thread(
                    link_provider_account_transition_once,
                    project_id=placement["projectId"],
                    target_account=target,
                    token=operator.token,
                    session=self._session,
                )
            except Exception as exc:  # noqa: BLE001 - the PUT may have reached Google
                return await self._retain_unknown(
                    intent, operator, expected_generation, expected_phase, allow_put, exc
                )
            try:
                after = await self._observe(placement, creation, operator.token)
            except Exception as exc:  # noqa: BLE001 - don't replay an uncertain PUT
                return await self._retain_unknown(
                    intent, operator, expected_generation, expected_phase, allow_put, exc
                )
            if after["billingAccountName"] == target and after["billingEnabled"] is True:
                return await self._settle(
                    intent, operator, placement, after, expected_generation, expected_phase
                )

        return await self._retain_unknown(
            intent,
            operator,
            expected_generation,
            expected_phase,
            allow_put,
            ProvisionReconciliationRequired("Native billing state did not confirm the target"),
        )

    async def _observe(
        self, placement: dict[str, Any], creation: dict[str, Any], token: str
    ) -> dict[str, Any]:
        await asyncio.to_thread(
            _observe_project_identity, self._session, placement, creation, token
        )
        billing = await asyncio.to_thread(
            observe_provider_account_transition_billing,
            project_id=placement["projectId"],
            old_account=OLD_BILLING_ACCOUNT,
            target_account=TARGET_BILLING_ACCOUNT,
            token=token,
            session=self._session,
        )
        return billing

    async def _settle(
        self,
        intent: dict[str, Any],
        operator: VerifiedOperator,
        placement: dict[str, Any],
        billing: dict[str, Any],
        generation: int,
        phase: str,
    ) -> dict[str, Any]:
        settlement = {
            "version": 1,
            "outcome": "settled",
            "observedAt": self._clock().astimezone(timezone.utc).isoformat(),
            "projectId": placement["projectId"],
            "projectNumber": placement["projectNumber"],
            "billingAccountName": TARGET_BILLING_ACCOUNT,
            "billingEnabled": True,
            "actorPrincipal": operator.principal,
            "operationId": intent["operationId"],
        }
        if billing != {
            "projectId": placement["projectId"],
            "billingAccountName": TARGET_BILLING_ACCOUNT,
            "billingEnabled": True,
        }:
            return await self._retain_unknown(
                intent,
                operator,
                generation,
                phase,
                False,
                ProvisionReconciliationRequired("Native billing readback is foreign"),
            )
        if not await self._journal.settle_provider_account_transition(
            owner_id=intent["ownerId"],
            attempt_id=placement["attemptId"],
            expected_generation=generation,
            expected_phase=phase,
            settlement=settlement,
        ):
            raise ProvisionReconciliationRequired("Provider account settlement was refused")
        return {"phase": "settled", "generation": generation + 1}

    async def _retain_unknown(
        self,
        intent: dict[str, Any],
        operator: VerifiedOperator,
        generation: int,
        phase: str,
        allow_put: bool,
        _cause: Exception,
    ) -> dict[str, Any]:
        if phase == "unknown":
            return {"phase": "unknown", "generation": generation}
        if not allow_put:
            settlement = {
                "version": 1,
                "outcome": "unknown",
                "observedAt": self._clock().astimezone(timezone.utc).isoformat(),
            }
            # A resumed intent may represent a process that stopped before any PUT.
            # Record uncertainty, then require future retries to remain GET-only.
            if not await self._journal.settle_provider_account_transition(
                owner_id=intent["ownerId"],
                attempt_id=intent["attemptId"],
                expected_generation=generation,
                expected_phase=phase,
                settlement=settlement,
            ):
                raise ProvisionReconciliationRequired("Provider unknown outcome was refused")
            return {"phase": "unknown", "generation": generation + 1}
        settlement = {
            "version": 1,
            "outcome": "unknown",
            "observedAt": self._clock().astimezone(timezone.utc).isoformat(),
        }
        if not await self._journal.settle_provider_account_transition(
            owner_id=intent["ownerId"],
            attempt_id=intent["attemptId"],
            expected_generation=generation,
            expected_phase=phase,
            settlement=settlement,
        ):
            raise ProvisionReconciliationRequired("Provider unknown outcome was refused")
        return {"phase": "unknown", "generation": generation + 1}


def _placement_for_row(row: dict[str, Any], owner_id: str) -> tuple[dict[str, Any], dict, dict]:
    placement = PLACEMENTS.get(str(row.get("hushh_id") or ""))
    if (
        not isinstance(placement, dict)
        or row.get("user_id") != owner_id
        or row.get("hushh_id") != placement["hushhId"]
    ):
        raise ProvisionReconciliationRequired(
            "Provider account transition placement is not admitted"
        )
    metadata = row.get("backend_metadata")
    attempt = metadata.get("provisionAttempt") if isinstance(metadata, dict) else None
    if not isinstance(metadata, dict) or not isinstance(attempt, dict):
        raise ProvisionReconciliationRequired("Provider account transition journal is unavailable")
    admission = attempt.get("hostedAdmission")
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    contract = assignment.get("preparationContract") if isinstance(assignment, dict) else None
    evidence_root = attempt.get("evidence")
    evidence = evidence_root.get("reserved") if isinstance(evidence_root, dict) else None
    if not isinstance(evidence, dict):
        raise ProvisionReconciliationRequired("Provider account transition evidence is unavailable")
    checkpoint = evidence.get("hostedPreparation")
    completed = checkpoint.get("completed") if isinstance(checkpoint, dict) else None
    if (
        row.get("status") != "provisioned"
        or row.get("deployment_target") != "gcp"
        or row.get("placement_epoch") != placement["placementEpoch"]
        or row.get("hushh_id") != placement["hushhId"]
        or metadata.get("project") != placement["projectId"]
        or metadata.get("serviceUid") != placement["serviceUid"]
        or metadata.get("runtime_service_account") != placement["runtimePrincipal"]
        or metadata.get("tenancy", "hussh-hosted") != "hussh-hosted"
        or attempt.get("ownerId") != owner_id
        or attempt.get("attemptId") != placement["attemptId"]
        or attempt.get("phase") != "provisioned"
        or not isinstance(attempt.get("intent"), dict)
        or attempt["intent"].get("user_id") != owner_id
        or attempt["intent"].get("hushh_id") != placement["hushhId"]
        or not isinstance(admission, dict)
        or admission.get("environment") != "dev"
        or admission.get("imageDigest") != IMAGE_DIGEST
        or not isinstance(assignment, dict)
        or assignment.get("hushhId") != placement["hushhId"]
        or assignment.get("ownerHash")
        != "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
        or assignment.get("project") != placement["projectId"]
        or assignment.get("projectNumber") not in {None, placement["projectNumber"]}
        or not isinstance(contract, dict)
        or contract.get("billingAccount") != OLD_BILLING_ACCOUNT
        or not isinstance(completed, list)
        or any(not isinstance(item, dict) for item in completed)
        or len(completed) != 5
        or [item.get("step") for item in completed]
        != [
            "create_project",
            "link_billing",
            "authorize_project",
            "inference_vertex",
            "inference_quota",
        ]
    ):
        raise ProvisionReconciliationRequired("Provider account transition identity differs")
    observation = evidence.get("projectObservation")
    creation_result = completed[0]
    creation = creation_result.get("resourceObservation", {}).get("identity")
    link_result = completed[1]
    billing = link_result.get("billingObservation")
    if (
        not isinstance(observation, dict)
        or observation.get("projectId") != placement["projectId"]
        or observation.get("projectNumber") != placement["projectNumber"]
        or not isinstance(creation, dict)
        or creation.get("projectId") != placement["projectId"]
        or creation.get("projectNumber") != placement["projectNumber"]
        or not isinstance(billing, dict)
        or billing.get("projectId") != placement["projectId"]
        or billing.get("billingAccountName") != OLD_BILLING_ACCOUNT
        or billing.get("billingEnabled") is not True
    ):
        raise ProvisionReconciliationRequired(
            "Provider account transition project evidence differs"
        )
    if "providerAccountTransition" in attempt:
        retained = attempt.get("providerAccountTransition")
        if not isinstance(retained, dict):
            raise ProvisionReconciliationRequired("Provider account transition is malformed")
        _validate_retained_intent(retained.get("intent", {}), placement, row)
    return placement, attempt, creation


def _new_intent(
    row: dict[str, Any],
    placement: dict[str, Any],
    attempt: dict[str, Any],
    _creation: dict[str, Any],
    operator: VerifiedOperator,
    now: datetime,
) -> dict[str, Any]:
    actor_verification = operator.provider_account_transition_verification()
    if actor_verification["verificationMethod"] != "google_userinfo_access_token_verified":
        raise ProvisionReconciliationRequired("Provider account transition proof type differs")
    return {
        "version": 1,
        "ownerId": row["user_id"],
        "attemptId": attempt["attemptId"],
        "placementEpoch": placement["placementEpoch"],
        "operationId": placement["operationId"],
        "projectId": placement["projectId"],
        "projectNumber": placement["projectNumber"],
        "oldBillingAccount": OLD_BILLING_ACCOUNT,
        "targetBillingAccount": TARGET_BILLING_ACCOUNT,
        "actorPrincipal": operator.principal,
        "actorVerification": actor_verification,
        "serviceUid": placement["serviceUid"],
        "runtimePrincipal": placement["runtimePrincipal"],
        "imageDigest": IMAGE_DIGEST,
        "intentAt": now.astimezone(timezone.utc).isoformat(),
    }


def _validate_retained_intent(intent: dict[str, Any], placement: dict[str, Any], row: dict) -> None:
    if not isinstance(intent, dict):
        raise ProvisionReconciliationRequired("Provider account transition intent is malformed")
    evidence = intent.get("actorVerification") if isinstance(intent, dict) else None
    attempt = row.get("backend_metadata", {}).get("provisionAttempt", {})
    retained_transition = attempt.get("providerAccountTransition", {})
    allow_legacy_actor_proof = (
        isinstance(retained_transition, dict) and retained_transition.get("intent") == intent
    )
    if (
        intent.get("ownerId") != row.get("user_id")
        or intent.get("attemptId") != placement["attemptId"]
        or intent.get("operationId") != placement["operationId"]
        or intent.get("projectId") != placement["projectId"]
        or intent.get("projectNumber") != placement["projectNumber"]
        or intent.get("placementEpoch") != placement["placementEpoch"]
        or intent.get("oldBillingAccount") != OLD_BILLING_ACCOUNT
        or intent.get("targetBillingAccount") != TARGET_BILLING_ACCOUNT
        or intent.get("actorPrincipal") != ACTOR_PRINCIPAL
        or intent.get("serviceUid") != placement["serviceUid"]
        or intent.get("runtimePrincipal") != placement["runtimePrincipal"]
        or intent.get("imageDigest") != IMAGE_DIGEST
        or not _valid_retained_actor_verification(evidence, allow_legacy=allow_legacy_actor_proof)
        or row.get("status") != "provisioned"
    ):
        raise ProvisionReconciliationRequired("Provider account transition intent is malformed")


def _valid_retained_actor_verification(evidence: Any, *, allow_legacy: bool) -> bool:
    if not isinstance(evidence, dict):
        return False
    common = (
        evidence.get("version") == 1
        and evidence.get("provider") == "google"
        and evidence.get("principal") == ACTOR_PRINCIPAL
        and evidence.get("email") == ACTOR_PRINCIPAL.removeprefix("user:")
        and evidence.get("emailVerified") is True
        and _SUBJECT_PATTERN.fullmatch(str(evidence.get("subject") or "")) is not None
        and isinstance(evidence.get("verifiedAt"), str)
        and bool(evidence.get("verifiedAt"))
    )
    userinfo_keys = {
        "version",
        "provider",
        "verificationMethod",
        "verificationEndpoint",
        "subject",
        "principal",
        "email",
        "emailVerified",
        "verifiedAt",
    }
    userinfo = (
        common
        and evidence.keys() == userinfo_keys
        and evidence.get("verificationMethod") == "google_userinfo_access_token_verified"
        and evidence.get("verificationEndpoint")
        == "https://openidconnect.googleapis.com/v1/userinfo"
    )
    legacy_keys = {
        "version",
        "provider",
        "issuer",
        "subject",
        "principal",
        "email",
        "emailVerified",
        "audience",
        "verificationMethod",
        "tokenSha256",
        "verifiedAt",
    }
    audience = evidence.get("audience")
    legacy = (
        common
        and evidence.keys() == legacy_keys
        and evidence.get("issuer") == "https://accounts.google.com"
        and evidence.get("verificationMethod") == "google_id_token_verified"
        and isinstance(evidence.get("tokenSha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", evidence["tokenSha256"]) is not None
        and isinstance(audience, str)
        and 0 < len(audience) <= 256
    )
    return bool(userinfo or (allow_legacy and legacy))


def _observe_project_identity(
    session: Any, placement: dict[str, Any], creation: dict[str, Any], token: str
) -> None:
    response = session.get(
        "https://cloudresourcemanager.googleapis.com/v1/projects/" + placement["projectId"],
        headers={"Authorization": "Bearer " + token},
        timeout=20,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise ProvisionReconciliationRequired("Native project identity is unverified")
    value = response.json()
    if (
        not isinstance(value, dict)
        or value.get("projectId") != placement["projectId"]
        or value.get("projectNumber") != placement["projectNumber"]
        or value.get("lifecycleState") != "ACTIVE"
        or any(value.get(key) != expected for key, expected in creation.items())
    ):
        raise ProvisionReconciliationRequired("Native project identity differs from placement")


def _installed_source_revision() -> str:
    import os

    value = str(os.getenv("HUSHH_DEPLOY_SHA") or "").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ProvisionReconciliationRequired("Installed control-plane source SHA is unavailable")
    return value
