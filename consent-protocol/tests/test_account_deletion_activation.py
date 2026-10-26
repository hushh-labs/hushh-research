"""Production activation preserves incompatible readers until governed retirement."""

import json
from types import SimpleNamespace

import pytest

from tests.test_account_deletion_release_workflow import (
    _activation_adapter,
    _activation_module,
)

pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


@pytest.fixture
def activation_case(monkeypatch, tmp_path):
    module = _activation_module()
    args = SimpleNamespace(
        project="hushh-pda",
        region="us-central1",
        backend_service="consent-protocol",
        backend_url="https://api.hushh.ai",
        oidc_audience="https://api.hushh.ai",
        scheduler_job="account-deletion-cleanup",
        scheduler_service_account="account-deletion-cleanup",
        expected_sha="a" * 40,
        expected_run_id="123",
        fence_required=True,
        evidence_prefix=str(tmp_path / "activation"),
    )
    calls, deleted = _activation_adapter(module, args, None, monkeypatch, phone_floor=True)
    return module, args, calls, deleted


def test_production_pending_activation_is_durable_and_never_mutates_readers_or_fence(
    activation_case, monkeypatch, tmp_path
):
    module, args, calls, deleted = activation_case
    monkeypatch.setattr(module, "parse_arguments", lambda: args)
    # A later continuation must preserve the original serving candidate origin.
    monkeypatch.setenv("GITHUB_RUN_ID", "999")
    assert module.main() == 0
    evidence = json.loads((tmp_path / "activation-activation.json").read_text())
    assert evidence == {
        "schema_version": 1,
        "kind": "account-lifecycle-activation",
        "status": "pending_activation",
        "fence_required": True,
        "project": "hushh-pda",
        "region": "us-central1",
        "service": "consent-protocol",
        "service_uid": "fixture-service",
        "sha": args.expected_sha,
        "run_id": "123",
        "candidate_revision": "consent-protocol-current",
        "candidate_uid": "fixture-current",
        "required_provider_contract": 2,
        "database_preflight": "qualified",
        "retirement": {
            "status": "pending",
            "pending_count": 2,
            "phone_admission_floor_required": True,
            "pending_revisions": [
                {
                    "revision": "consent-protocol-legacy",
                    "uid": "fixture-legacy",
                    "source": "c" * 40,
                    "traffic_percent": 0,
                    "tags": ["legacy-test"],
                },
                {
                    "revision": "consent-protocol-prephone",
                    "uid": "fixture-prephone",
                    "source": "d" * 40,
                    "traffic_percent": 0,
                    "tags": ["prephone-test"],
                },
            ],
        },
    }
    assert not deleted
    assert all(call[0] != "bash" and "scheduler" not in call for call in calls)
    assert not any("update-traffic" in call or "delete" in call for call in calls)
    assert not any("remove_release_fence.sql" in arg for call in calls for arg in call)


def test_production_activates_only_after_actual_retirement_is_observed(
    activation_case, monkeypatch
):
    module, args, calls, deleted = activation_case
    # Model the subsequent canonical maintenance result, without deleting here.
    deleted.extend(["consent-protocol-legacy", "consent-protocol-prephone"])
    original = module.run

    def run(argv, **kwargs):
        value = original(argv, **kwargs)
        if argv[:4] == ["gcloud", "run", "services", "describe"]:
            service = json.loads(value)
            service["status"]["traffic"] = [
                row for row in service["status"]["traffic"] if row["revisionName"] not in deleted
            ]
            return json.dumps(service)
        return value

    monkeypatch.setattr(module, "run", run)
    evidence = {"status": "blocked"}
    module.activate(args, evidence)
    assert evidence["status"] == "activated"
    assert evidence["candidate_uid"] == "fixture-current"
    assert evidence["retirement"]["retired_count"] == 0
    assert evidence["retirement"]["remaining_pre_phone431_count"] == 0
    assert evidence["scheduler"]["completion"]["http_status"] == 200
    assert evidence["fence_removal"] == "confirmed_absent"
    assert not any("update-traffic" in call or "delete" in call for call in calls)


@pytest.mark.parametrize("changed", ["uid", "source", "candidate-origin", "database", "fence"])
def test_production_pending_refuses_unknown_identity_or_unqualified_database(
    activation_case, monkeypatch, changed
):
    module, args, calls, _deleted = activation_case
    if changed == "fence":
        args.fence_required = False
    original = module.run

    def run(argv, **kwargs):
        value = original(argv, **kwargs)
        if argv[:4] == ["gcloud", "run", "revisions", "list"]:
            rows = json.loads(value)
            if changed in {"uid", "source"}:
                metadata = rows[1]["metadata"]
                if changed == "uid":
                    metadata.pop("uid")
                else:
                    metadata["labels"].pop("deploy-sha")
            if changed == "candidate-origin":
                rows[0]["metadata"]["labels"]["github-run-id"] = "999"
            return json.dumps(rows)
        if changed == "database" and "--command" in argv and "contract_version()" in argv[-1]:
            return "1"
        return value

    monkeypatch.setattr(module, "run", run)
    evidence = {"status": "blocked"}
    with pytest.raises((ValueError, RuntimeError)):
        module.activate(args, evidence)
    assert evidence["status"] == "blocked"
    assert all(call[0] != "bash" and "scheduler" not in call for call in calls)
    assert not any("update-traffic" in call or "delete" in call for call in calls)
