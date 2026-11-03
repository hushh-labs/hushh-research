"""Actor verification and single-write provider transition behavior."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hushh_mcp.services.hosted_operator_identity import VerifiedOperator, verify_operator
from hushh_mcp.services.hosted_provider_account_transition import (
    IMAGE_DIGEST,
    OLD_BILLING_ACCOUNT,
    PLACEMENTS,
    TARGET_BILLING_ACCOUNT,
    TRANSITION_ACTOR_PRINCIPAL,
    HostedProviderAccountTransition,
)
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


def test_operator_identity_checks_authenticated_subject_not_a_supplied_email():
    credentials = Mock()
    credentials.token = "synthetic"
    session = Mock()
    session.get.return_value = Mock(
        status_code=200,
        json=lambda: {"email": "foreign@example.test", "email_verified": True, "sub": "foreign"},
    )
    with pytest.raises(ProvisionReconciliationRequired, match="retained identity"):
        verify_operator(credentials, session, expected="user:operator@example.test")
    session.get.return_value = Mock(
        status_code=200,
        json=lambda: {"email": "operator@example.test", "email_verified": True, "sub": "operator"},
    )
    verified = verify_operator(credentials, session, expected="user:operator@example.test")
    assert verified.principal == "user:operator@example.test"
    assert "synthetic" not in repr(verified)
    proof = verified.provider_account_transition_verification()
    assert proof == {
        "version": 1,
        "provider": "google",
        "verificationMethod": "google_userinfo_access_token_verified",
        "verificationEndpoint": "https://openidconnect.googleapis.com/v1/userinfo",
        "subject": "operator",
        "principal": "user:operator@example.test",
        "email": "operator@example.test",
        "emailVerified": True,
        "verifiedAt": verified.verified_at,
    }
    assert "audience" not in proof and "issuer" not in proof


def _placement_row(owner_id: str, placement: dict) -> tuple[dict, dict]:
    project = placement["projectId"]
    identity = {
        "projectId": project,
        "projectNumber": placement["projectNumber"],
        "lifecycleState": "ACTIVE",
        "parent": {"type": "folder", "id": "1085913534660"},
        "labels": {"hussh-provision-attempt": placement["attemptId"]},
    }
    completed = [
        {
            "step": "create_project",
            "ok": True,
            "resourceObservation": {"identity": deepcopy(identity)},
        },
        {
            "step": "link_billing",
            "ok": True,
            "billingObservation": {
                "projectId": project,
                "billingAccountName": OLD_BILLING_ACCOUNT,
                "billingEnabled": True,
            },
        },
        {"step": "authorize_project", "ok": True},
        {"step": "inference_vertex", "ok": True},
        {"step": "inference_quota", "ok": True},
    ]
    row = {
        "user_id": owner_id,
        "hushh_id": placement["hushhId"],
        "placement_epoch": 0,
        "status": "provisioned",
        "deployment_target": "gcp",
        "backend_metadata": {
            "project": project,
            "serviceUid": placement["serviceUid"],
            "runtime_service_account": placement["runtimePrincipal"],
            "tenancy": "hussh-hosted",
            "provisionAttempt": {
                "ownerId": owner_id,
                "attemptId": placement["attemptId"],
                "phase": "provisioned",
                "intent": {"user_id": owner_id, "hushh_id": placement["hushhId"]},
                "hostedAdmission": {
                    "environment": "dev",
                    "imageDigest": IMAGE_DIGEST,
                    "assignment": {
                        "ownerHash": "sha256:" + hashlib.sha256(owner_id.encode()).hexdigest(),
                        "hushhId": placement["hushhId"],
                        "project": project,
                        "projectNumber": placement["projectNumber"],
                        "preparationContract": {"billingAccount": OLD_BILLING_ACCOUNT},
                    },
                },
                "evidence": {
                    "reserved": {
                        "projectObservation": {
                            "projectId": project,
                            "projectNumber": placement["projectNumber"],
                            "lifecycleState": "ACTIVE",
                        },
                        "hostedPreparation": {"completed": completed},
                    }
                },
            },
        },
    }
    return row, identity


class _Registry:
    def __init__(self, owner_id: str, row: dict) -> None:
        self.owner_id = owner_id
        self.row = row

    async def get(self, requested_owner: str) -> dict:
        assert requested_owner == self.owner_id
        return deepcopy(self.row)


class _Journal:
    def __init__(self, owner_id: str, placement: dict, row: dict) -> None:
        self.owner_id = owner_id
        self.placement = placement
        self.row = row
        self.events = []

    async def record_provider_account_transition_intent(
        self, *, owner_id: str, attempt_id: str, intent: dict
    ) -> bool:
        assert owner_id == self.row["user_id"]
        assert attempt_id == self.placement["attemptId"]
        self.events.append("intent")
        retained_intent = {**intent, "minimumSourceRevision": "d" * 40}
        self.row["backend_metadata"]["provisionAttempt"]["providerAccountTransition"] = {
            "version": 1,
            "generation": 1,
            "phase": "intent",
            "intent": retained_intent,
            "settlements": [],
        }
        return True

    async def settle_provider_account_transition(
        self, *, owner_id, attempt_id, expected_generation, expected_phase, settlement
    ) -> bool:
        transition = self.row["backend_metadata"]["provisionAttempt"]["providerAccountTransition"]
        assert owner_id == self.row["user_id"] and attempt_id == self.placement["attemptId"]
        assert transition["generation"] == expected_generation
        assert transition["phase"] == expected_phase
        self.events.append(settlement["outcome"])
        transition.update(
            generation=expected_generation + 1,
            phase=settlement["outcome"],
            settlements=transition["settlements"] + [settlement],
        )
        return True


class _Response:
    def __init__(self, body: dict, status_code: int = 200) -> None:
        self._body = body
        self.status_code = status_code

    def json(self) -> dict:
        return deepcopy(self._body)


class _Session:
    def __init__(self, project: str, identity: dict, journal: _Journal, put_mode: str) -> None:
        self.project = project
        self.identity = identity
        self.journal = journal
        self.put_mode = put_mode
        self.billing_account = OLD_BILLING_ACCOUNT
        self.put_count = 0
        self.get_urls = []

    def get(self, url: str, **_kwargs) -> _Response:
        self.get_urls.append(url)
        if url.endswith("/billingInfo"):
            return _Response(
                {
                    "projectId": self.project,
                    "billingAccountName": self.billing_account,
                    "billingEnabled": True,
                }
            )
        if url.endswith("/" + TARGET_BILLING_ACCOUNT):
            return _Response({"name": TARGET_BILLING_ACCOUNT, "open": True})
        if url.endswith("/projects/" + self.project):
            return _Response(self.identity)
        raise AssertionError("unexpected GET target")

    def put(self, url: str, **_kwargs) -> _Response:
        assert self.journal.events[-1] == "intent"
        assert url.endswith("/projects/" + self.project + "/billingInfo")
        self.put_count += 1
        self.billing_account = TARGET_BILLING_ACCOUNT
        if self.put_mode == "timeout":
            raise TimeoutError("simulated ambiguous provider timeout")
        return _Response({"projectId": self.project})


def _transition_scenario(monkeypatch, put_mode: str):
    owner_id = "owner-a"
    placement = PLACEMENTS["ha1_t6cqxavpt6sumlllpfcjrwkh4fztw5zq"]
    row, identity = _placement_row(owner_id, placement)
    operator_token = "synthetic-access-token"
    operator = VerifiedOperator(
        principal=TRANSITION_ACTOR_PRINCIPAL,
        token=operator_token,
        subject="google-subject-a",
        email=TRANSITION_ACTOR_PRINCIPAL.removeprefix("user:"),
        email_verified=True,
        verified_at=datetime.now(timezone.utc).isoformat(),
    )
    monkeypatch.setenv("HUSHH_DEPLOY_SHA", "d" * 40)
    monkeypatch.setattr(
        "hushh_mcp.services.hosted_provider_account_transition.verify_operator",
        lambda *_args, **_kwargs: operator,
    )
    journal = _Journal(owner_id, placement, row)
    session = _Session(placement["projectId"], identity, journal, put_mode)
    service = HostedProviderAccountTransition(
        _Registry(owner_id, row), credentials=object(), session=session, journal=journal
    )
    return SimpleNamespace(
        owner_id=owner_id,
        placement=placement,
        row=row,
        operator_token=operator_token,
        journal=journal,
        session=session,
        service=service,
    )


def _assert_first_outcome(scenario, result: dict, put_mode: str) -> bool:
    assert scenario.session.put_count == 1
    assert scenario.journal.events[0] == "intent"
    assert scenario.session.get_urls
    transition = scenario.row["backend_metadata"]["provisionAttempt"]["providerAccountTransition"]
    assert scenario.operator_token not in json.dumps(transition)
    assert "tokenSha256" not in transition["intent"]["actorVerification"]
    assert transition["intent"]["operationId"] == scenario.placement["operationId"]
    assert "operationId" not in scenario.row["backend_metadata"]["provisionAttempt"]
    if put_mode == "success":
        assert result == {"phase": "settled", "generation": 2}
        assert transition["settlements"][-1]["billingAccountName"] == TARGET_BILLING_ACCOUNT
        return False
    assert result == {"phase": "unknown", "generation": 2}
    return True


async def _assert_get_only_resume(scenario) -> None:
    before_resume_put_count = scenario.session.put_count
    result = await scenario.service.resume(owner_id=scenario.owner_id)
    transition = scenario.row["backend_metadata"]["provisionAttempt"]["providerAccountTransition"]
    assert result == {"phase": "settled", "generation": 3}
    assert scenario.session.put_count == before_resume_put_count == 1
    assert scenario.journal.events[-1] == "settled"
    assert transition["settlements"][0]["outcome"] == "unknown"
    assert transition["settlements"][1]["outcome"] == "settled"


@pytest.mark.parametrize("put_mode", ["success", "timeout"])
async def test_provider_account_transition_persists_before_single_put_and_resumes_get_only(
    monkeypatch, put_mode
):
    scenario = _transition_scenario(monkeypatch, put_mode)
    first = await scenario.service.start(owner_id=scenario.owner_id)
    if _assert_first_outcome(scenario, first, put_mode):
        await _assert_get_only_resume(scenario)
    else:
        get_count = len(scenario.session.get_urls)
        assert await scenario.service.resume(owner_id=scenario.owner_id) == {
            "phase": "settled",
            "generation": 2,
        }
        assert len(scenario.session.get_urls) == get_count


@pytest.mark.parametrize(
    ("principal", "email", "email_verified", "subject"),
    [
        (TRANSITION_ACTOR_PRINCIPAL, "foreign@example.test", True, "subject-a"),
        (TRANSITION_ACTOR_PRINCIPAL, "kushal.trivedi97@gmail.com", False, "subject-a"),
        (TRANSITION_ACTOR_PRINCIPAL, "kushal.trivedi97@gmail.com", True, ""),
        ("user:kushaltrivedi97@gmail.com", "kushaltrivedi97@gmail.com", True, "legacy"),
    ],
    ids=("wrong-email", "unverified-email", "missing-subject", "legacy-actor-new-start"),
)
async def test_new_intent_requires_exact_dotted_verified_actor(
    monkeypatch, principal, email, email_verified, subject
):
    scenario = _transition_scenario(monkeypatch, "success")
    invalid = VerifiedOperator(
        principal=principal,
        token=scenario.operator_token,
        subject=subject,
        email=email,
        email_verified=email_verified,
        verified_at=datetime.now(timezone.utc).isoformat(),
    )
    scenario.service._runtime._verify_operator_fn = lambda *_args, **_kwargs: invalid

    with pytest.raises(ProvisionReconciliationRequired, match="actor is invalid"):
        await scenario.service.start(owner_id=scenario.owner_id)

    assert scenario.journal.events == []
    assert scenario.session.put_count == 0
    assert scenario.session.get_urls == []


async def test_dotted_operator_cannot_take_over_retained_legacy_intent(monkeypatch):
    scenario = _transition_scenario(monkeypatch, "success")
    intent = {
        "version": 1,
        "ownerId": scenario.owner_id,
        "attemptId": scenario.placement["attemptId"],
        "placementEpoch": 0,
        "operationId": scenario.placement["operationId"],
        "projectId": scenario.placement["projectId"],
        "projectNumber": scenario.placement["projectNumber"],
        "oldBillingAccount": OLD_BILLING_ACCOUNT,
        "targetBillingAccount": TARGET_BILLING_ACCOUNT,
        "actorPrincipal": "user:kushaltrivedi97@gmail.com",
        "actorVerification": {
            "version": 1,
            "provider": "google",
            "verificationMethod": "google_userinfo_access_token_verified",
            "verificationEndpoint": "https://openidconnect.googleapis.com/v1/userinfo",
            "subject": "legacy-subject",
            "principal": "user:kushaltrivedi97@gmail.com",
            "email": "kushaltrivedi97@gmail.com",
            "emailVerified": True,
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
        },
        "serviceUid": scenario.placement["serviceUid"],
        "runtimePrincipal": scenario.placement["runtimePrincipal"],
        "imageDigest": IMAGE_DIGEST,
        "intentAt": datetime.now(timezone.utc).isoformat(),
    }
    scenario.row["backend_metadata"]["provisionAttempt"]["providerAccountTransition"] = {
        "version": 1,
        "generation": 2,
        "phase": "unknown",
        "intent": intent,
        "settlements": [{"version": 1, "outcome": "unknown", "observedAt": intent["intentAt"]}],
    }

    with pytest.raises(ProvisionReconciliationRequired, match="actor is invalid"):
        await scenario.service.resume(owner_id=scenario.owner_id)

    assert scenario.session.get_urls == []
    assert scenario.session.put_count == 0


@pytest.mark.parametrize(
    ("email", "subject"),
    [
        ("foreign@example.test", "google-subject-a"),
        ("kushal.trivedi97@gmail.com", "different-subject"),
    ],
    ids=("retained-email-mismatch", "retained-subject-mismatch"),
)
async def test_resume_requires_exact_recorded_dotted_email_and_subject(monkeypatch, email, subject):
    scenario = _transition_scenario(monkeypatch, "success")
    await scenario.service.start(owner_id=scenario.owner_id)
    transition = scenario.row["backend_metadata"]["provisionAttempt"]["providerAccountTransition"]
    transition["phase"] = "unknown"
    transition["generation"] = 2
    transition["settlements"] = [
        {"version": 1, "outcome": "unknown", "observedAt": transition["intent"]["intentAt"]}
    ]
    mismatched_operator = VerifiedOperator(
        principal=TRANSITION_ACTOR_PRINCIPAL,
        token=scenario.operator_token,
        subject=subject,
        email=email,
        email_verified=True,
        verified_at=datetime.now(timezone.utc).isoformat(),
    )
    scenario.service._runtime._verify_operator_fn = lambda *_args, **_kwargs: mismatched_operator
    before_get_count = len(scenario.session.get_urls)

    with pytest.raises(ProvisionReconciliationRequired, match="actor"):
        await scenario.service.resume(owner_id=scenario.owner_id)

    assert len(scenario.session.get_urls) == before_get_count
    assert scenario.session.put_count == 1
