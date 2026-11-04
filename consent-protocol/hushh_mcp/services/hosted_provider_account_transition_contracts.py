"""Fixed pilot identity and retained transition validation."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.hosted_operator_identity import VerifiedOperator
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

ACTOR_PRINCIPAL = "user:kushaltrivedi97@gmail.com"
TRANSITION_ACTOR_PRINCIPAL = "user:kushal.trivedi97@gmail.com"
OLD_BILLING_ACCOUNT = "billingAccounts/014D7F-FD970D-D2459E"
TARGET_BILLING_ACCOUNT = "billingAccounts/013848-8258FA-2D068F"
IMAGE_DIGEST = "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
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


def placement_for_row(row: dict[str, Any], owner_id: str) -> tuple[dict[str, Any], dict, dict]:
    placement = PLACEMENTS.get(str(row.get("hushh_id") or ""))
    if (
        not isinstance(placement, dict)
        or row.get("user_id") != owner_id
        or row.get("hushh_id") != placement["hushhId"]
    ):
        raise ProvisionReconciliationRequired(
            "Provider account transition placement is not admitted"
        )
    metadata, attempt = _attempt_for_row(row)
    _validate_attempt_admission(row, owner_id, placement, metadata, attempt)
    creation = _creation_evidence(row, placement, attempt)
    _validate_existing_transition(attempt, placement, row)
    return placement, attempt, creation


def _attempt_for_row(row: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    metadata = row.get("backend_metadata")
    attempt = metadata.get("provisionAttempt") if isinstance(metadata, dict) else None
    if not isinstance(metadata, dict) or not isinstance(attempt, dict):
        raise ProvisionReconciliationRequired("Provider account transition journal is unavailable")
    return metadata, attempt


def _validate_attempt_admission(
    row: dict[str, Any],
    owner_id: str,
    placement: dict[str, Any],
    metadata: dict[str, Any],
    attempt: dict[str, Any],
) -> None:
    admission = attempt.get("hostedAdmission")
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    contract = assignment.get("preparationContract") if isinstance(assignment, dict) else None
    evidence_root = attempt.get("evidence")
    evidence = evidence_root.get("reserved") if isinstance(evidence_root, dict) else None
    checkpoint = evidence.get("hostedPreparation") if isinstance(evidence, dict) else None
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
        or assignment.get("ownerHash") != _owner_hash(owner_id)
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


def _owner_hash(owner_id: str) -> str:
    return "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def _creation_evidence(
    row: dict[str, Any], placement: dict[str, Any], attempt: dict[str, Any]
) -> dict[str, Any]:
    evidence = attempt["evidence"]["reserved"]
    observation = evidence.get("projectObservation")
    completed = evidence["hostedPreparation"]["completed"]
    creation = completed[0].get("resourceObservation", {}).get("identity")
    billing = completed[1].get("billingObservation")
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
    if row.get("placement_epoch") != placement["placementEpoch"]:
        raise ProvisionReconciliationRequired("Provider account transition epoch differs")
    return creation


def _validate_existing_transition(
    attempt: dict[str, Any], placement: dict[str, Any], row: dict[str, Any]
) -> None:
    if "providerAccountTransition" not in attempt:
        return
    retained = attempt.get("providerAccountTransition")
    if not isinstance(retained, dict):
        raise ProvisionReconciliationRequired("Provider account transition is malformed")
    validate_retained_intent(retained.get("intent", {}), placement, row)


def new_intent(
    row: dict[str, Any],
    placement: dict[str, Any],
    attempt: dict[str, Any],
    _creation: dict[str, Any],
    operator: VerifiedOperator,
    now: datetime,
) -> dict[str, Any]:
    actor_verification = operator.provider_account_transition_verification()
    if not valid_operator_identity(operator, expected=TRANSITION_ACTOR_PRINCIPAL) or (
        actor_verification["verificationMethod"] != "google_userinfo_access_token_verified"
    ):
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


def validate_retained_intent(intent: dict[str, Any], placement: dict[str, Any], row: dict) -> None:
    if not isinstance(intent, dict):
        raise ProvisionReconciliationRequired("Provider account transition intent is malformed")
    evidence = intent.get("actorVerification") if isinstance(intent, dict) else None
    attempt = row.get("backend_metadata", {}).get("provisionAttempt", {})
    retained_transition = attempt.get("providerAccountTransition", {})
    exact_retained_intent = (
        isinstance(retained_transition, dict) and retained_transition.get("intent") == intent
    )
    actor_principal = intent.get("actorPrincipal")
    if not isinstance(actor_principal, str) or actor_principal not in {
        ACTOR_PRINCIPAL,
        TRANSITION_ACTOR_PRINCIPAL,
    }:
        raise ProvisionReconciliationRequired("Provider account transition actor is malformed")
    if actor_principal == ACTOR_PRINCIPAL and not exact_retained_intent:
        raise ProvisionReconciliationRequired("Legacy provider transition actor is not retained")
    if (
        intent.get("ownerId") != row.get("user_id")
        or intent.get("attemptId") != placement["attemptId"]
        or intent.get("operationId") != placement["operationId"]
        or intent.get("projectId") != placement["projectId"]
        or intent.get("projectNumber") != placement["projectNumber"]
        or intent.get("placementEpoch") != placement["placementEpoch"]
        or intent.get("oldBillingAccount") != OLD_BILLING_ACCOUNT
        or intent.get("targetBillingAccount") != TARGET_BILLING_ACCOUNT
        or actor_principal not in {ACTOR_PRINCIPAL, TRANSITION_ACTOR_PRINCIPAL}
        or intent.get("serviceUid") != placement["serviceUid"]
        or intent.get("runtimePrincipal") != placement["runtimePrincipal"]
        or intent.get("imageDigest") != IMAGE_DIGEST
        or not valid_retained_actor_verification(
            evidence,
            actor_principal=actor_principal,
            allow_legacy=exact_retained_intent,
        )
        or row.get("status") != "provisioned"
    ):
        raise ProvisionReconciliationRequired("Provider account transition intent is malformed")


def valid_retained_actor_verification(
    evidence: Any, *, actor_principal: str, allow_legacy: bool
) -> bool:
    if not isinstance(evidence, dict):
        return False
    expected_email = actor_principal.removeprefix("user:")
    common = (
        evidence.get("version") == 1
        and evidence.get("provider") == "google"
        and evidence.get("principal") == actor_principal
        and evidence.get("email") == expected_email
        and evidence.get("emailVerified") is True
        and _SUBJECT_PATTERN.fullmatch(str(evidence.get("subject") or "")) is not None
        and isinstance(evidence.get("verifiedAt"), str)
        and bool(evidence.get("verifiedAt"))
    )
    userinfo = _valid_userinfo_proof(evidence, common)
    legacy = (
        allow_legacy
        and actor_principal == ACTOR_PRINCIPAL
        and _valid_legacy_proof(evidence, common)
    )
    return bool(userinfo or legacy)


def _valid_userinfo_proof(evidence: dict[str, Any], common: bool) -> bool:
    expected_keys = {
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
    return (
        common
        and evidence.keys() == expected_keys
        and evidence.get("verificationMethod") == "google_userinfo_access_token_verified"
        and evidence.get("verificationEndpoint")
        == "https://openidconnect.googleapis.com/v1/userinfo"
    )


def _valid_legacy_proof(evidence: dict[str, Any], common: bool) -> bool:
    expected_keys = {
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
    return (
        common
        and evidence.keys() == expected_keys
        and evidence.get("issuer") == "https://accounts.google.com"
        and evidence.get("verificationMethod") == "google_id_token_verified"
        and isinstance(evidence.get("tokenSha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", evidence["tokenSha256"]) is not None
        and isinstance(audience, str)
        and 0 < len(audience) <= 256
    )


def valid_operator_identity(operator: VerifiedOperator, *, expected: str = ACTOR_PRINCIPAL) -> bool:
    return (
        expected in {ACTOR_PRINCIPAL, TRANSITION_ACTOR_PRINCIPAL}
        and operator.principal == expected
        and operator.email == expected.removeprefix("user:")
        and operator.email_verified is True
        and _SUBJECT_PATTERN.fullmatch(operator.subject) is not None
    )


def installed_source_revision() -> str:
    import os

    value = str(os.getenv("HUSHH_DEPLOY_SHA") or "").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ProvisionReconciliationRequired("Installed control-plane source SHA is unavailable")
    return value
