"""Connect Azure applied end to end against an in-memory ARM: stages, idempotence,
the setup binding, the typed model outcome, and nothing sent with a placeholder."""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services import azure_agent_setup as setup
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused, SetupApplier
from hushh_mcp.services.azure_setup_plan import (
    AZURE_JOB_STAGES,
    BINDING_TAG,
    NONCE_TAG,
    PlanInputs,
    resource_group_name,
    setup_binding,
)
from hushh_mcp.services.compute_backend import PodSpec
from tests.azure_arm_fake import POD_PRINCIPAL, FakeArm

_HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
_TENANT = "11111111-1111-1111-1111-111111111111"
_PERSON_TOKEN = "person-token-for-tests"  # noqa: S105 - no service exists to authenticate to
_SUB = "22222222-2222-2222-2222-222222222222"
_HUSSH_SP = "88888888-8888-8888-8888-888888888888"
_IMAGE = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/consent-protocol-pod@sha256:" + "b" * 64


def _group() -> str:
    """Per test: conftest swaps APP_SIGNING_KEY, and the name is a keyed digest."""
    return f"/subscriptions/{_SUB}/resourceGroups/{resource_group_name(_HUSHH_ID)}"


class _Http:
    def __init__(self, statuses=(200,)):
        self.statuses = list(statuses)
        self.urls: list[str] = []

    def get(self, url, timeout=None):
        self.urls.append(url)
        status = self.statuses.pop(0) if self.statuses else 503

        class _R:
            status_code = status

        return _R()


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )


def _spec() -> PodSpec:
    return PodSpec(hushh_id=_HUSHH_ID, phone_e164_hash="h", pod_pubkey="", billing_space_id="b")


def _run(arm: FakeArm, *, http=None, stages=None, credentials=None):
    stages = stages if stages is not None else []
    return setup.run_agent_setup(
        access_token=_PERSON_TOKEN,
        tenant_id=_TENANT,
        subscription_id=_SUB,
        location="eastus2",
        spec=_spec(),
        source_image=_IMAGE,
        advance=stages.append,
        arm=arm,
        hussh_principal_id=_HUSSH_SP,
        image_credentials=credentials,
        http=http or _Http(),
        sleep=lambda _s: None,
    )


def test_a_fresh_setup_runs_every_stage_in_order_and_proves_the_agent():
    arm, stages, http = FakeArm(), [], _Http()
    result = _run(arm, http=http, stages=stages)
    assert stages == list(AZURE_JOB_STAGES)
    assert result.model_credential_mode == "user_azure_mi"
    assert result.pod_principal_id == POD_PRINCIPAL
    assert result.fqdn.endswith(".azurecontainerapps.io")
    assert http.urls == [f"https://{result.fqdn}/health"]
    assert result.resource_group == resource_group_name(_HUSHH_ID)
    assert result.image_digest == "sha256:" + "b" * 64


def test_nothing_is_ever_sent_with_an_unresolved_placeholder_or_the_secret_in_a_log():
    arm = FakeArm()
    _run(arm)
    sent = json.dumps([(m, p, b) for m, p, b in arm.calls if m != "GET"])
    assert "${" not in sent
    secret = next(
        b for m, p, b in arm.calls if m == "PUT" and p.endswith("/secrets/pod-signing-key")
    )
    assert len(secret["properties"]["value"]) >= 48
    hussh = [
        b
        for m, p, b in arm.calls
        if b and (b.get("properties") or {}).get("principalId") == _HUSSH_SP
    ]
    assert len(hussh) == 3


def test_a_rerun_reuses_the_bound_group_and_never_rotates_the_key_or_secret():
    arm = FakeArm()
    first = _run(arm)
    second_calls_start = len(arm.calls)
    second = _run(arm)
    assert second.nonce == first.nonce
    rerun_puts = [p for m, p, _ in arm.calls[second_calls_start:] if m == "PUT"]
    assert not any(
        p.endswith("/keys/pod-log-key") or p.endswith("/secrets/pod-signing-key")
        for p in rerun_puts
    )


def test_a_group_hussh_did_not_create_for_this_person_is_refused_untouched():
    arm = FakeArm()
    arm.resources[_group()] = {"tags": {NONCE_TAG: "0123456789abcdef", BINDING_TAG: "forged"}}
    with pytest.raises(AzureSetupRefused) as exc:
        _run(arm)
    assert exc.value.code == "RESOURCE_GROUP_FOREIGN"
    assert arm.writes() == []


def test_a_group_bound_to_another_agent_is_refused():
    arm = FakeArm()
    other = setup_binding("ha1_someoneelse", "0123456789abcdef")
    arm.resources[_group()] = {"tags": {NONCE_TAG: "0123456789abcdef", BINDING_TAG: other}}
    with pytest.raises(AzureSetupRefused):
        _run(arm)


def test_a_refused_model_is_a_typed_outcome_and_the_agent_serves_the_owners_key():
    arm = FakeArm()
    arm.fail(
        "PUT",
        "/deployments/one-chat",
        ArmError("failed", status=200, code="InsufficientQuota", message="", op="x"),
    )
    result = _run(arm)
    assert (result.model_outcome, result.model_credential_mode) == (
        "quota_refused",
        "byok_per_turn",
    )
    assert not any(
        "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd" in json.dumps(b) for _, _, b in arm.calls if b
    )
    app = next(
        b for m, p, b in arm.calls if m == "PUT" and p.endswith("/containerApps/ca-hussh-one-pod")
    )
    names = {e["name"] for e in app["properties"]["template"]["containers"][0]["env"]}
    assert "AZURE_OPENAI_ENDPOINT" not in names


def test_an_existing_assignment_is_success_and_a_new_principal_is_waited_for():
    arm = FakeArm()
    exists = ArmError("conflict", status=409, code="RoleAssignmentExists", message="", op="x")
    settling = ArmError("bad_request", status=400, code="PrincipalNotFound", message="", op="x")
    arm.fail("PUT", "/roleAssignments/", exists, settling, settling)
    _run(arm)


def test_an_unexpected_refusal_stops_the_setup():
    arm = FakeArm()
    arm.fail(
        "PUT",
        "/vaults/",
        ArmError("forbidden", status=403, code="AuthorizationFailed", message="", op="x"),
    )
    with pytest.raises(ArmError) as exc:
        _run(arm)
    assert exc.value.kind == "forbidden"


def test_image_credentials_exist_only_in_the_one_import_call():
    arm = FakeArm()
    _run(arm, credentials=lambda: {"username": "oauth2accesstoken", "password": "short-lived"})
    imports = [b for m, p, b in arm.calls if p.endswith("/importImage")]
    assert imports and imports[0]["source"]["credentials"]["username"] == "oauth2accesstoken"
    assert imports[0]["source"]["sourceImage"].endswith("@sha256:" + "b" * 64)
    assert sum("short-lived" in json.dumps(b) for _, _, b in arm.calls if b) == 1


def test_an_agent_that_never_answers_is_a_typed_refusal_with_everything_kept():
    arm = FakeArm()
    with pytest.raises(AzureSetupRefused) as exc:
        _run(arm, http=_Http(statuses=()))
    assert exc.value.code == "AGENT_NOT_SERVING"
    assert any(p.endswith("/containerApps/ca-hussh-one-pod") for _, p in arm.writes())


def test_a_tagged_image_is_refused_before_any_azure_call():
    arm = FakeArm()
    with pytest.raises(AzureSetupRefused) as exc:
        setup.run_agent_setup(
            access_token=_PERSON_TOKEN, tenant_id=_TENANT, subscription_id=_SUB, location="eastus2",
            spec=_spec(), source_image="us-central1-docker.pkg.dev/p/r/consent-protocol-pod:latest",
            advance=lambda _s: None, arm=arm, hussh_principal_id=_HUSSH_SP,
        )  # fmt: skip
    assert exc.value.code == "IMAGE_NOT_PINNED"
    assert arm.calls == []


def test_the_applier_refuses_a_step_whose_value_is_not_known():
    arm = FakeArm()
    plan_for = setup.plan_factory(
        _spec(), source_registry="r.example.com", source_repository="p/r", incarnation="i"
    )
    inputs = PlanInputs(
        _HUSHH_ID, _TENANT, _SUB, "eastus2", resource_group_name(_HUSHH_ID), "0" * 16
    )
    with pytest.raises(AzureSetupRefused) as exc:
        SetupApplier(arm, advance=lambda _s: None, sleep=lambda _s: None).apply(
            plan_for(inputs), values={"imageDigest": "sha256:" + "c" * 64}, plan_for=plan_for
        )
    assert exc.value.code == "PLAN_UNRESOLVED"
