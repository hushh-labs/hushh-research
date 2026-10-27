"""In-memory selection read transport; the application guard remains real."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


class SelectionDatabase:
    def __init__(self):
        self.row = {"user_id": "u1", "hushh_id": "ha1_test", "status": "pending"}
        self.records = True
        self.calls = []

    def execute_raw(self, query, params):
        self.calls.append((query, params))
        return SimpleNamespace(
            data=[{"hushh_id": "ha1_test", "registry_row": self.row}]
            if self.records and params["owner"] == "u1"
            else []
        )


def selection_runtime(monkeypatch):
    from hushh_mcp.services import hosted_engine_location_contract, pod_release

    monkeypatch.setattr(
        hosted_engine_location_contract,
        "provider_contract",
        lambda now: {
            "qualificationExpiresAt": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        },
    )

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSHH_DEPLOY_SHA", "a" * 40)
    monkeypatch.setenv(
        "HUSSH_ONE_POD_IMAGE", "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "b" * 64
    )
    monkeypatch.setattr(pod_release, "configured_release", lambda _: {"sourceRevision": "a" * 40})
    return SelectionDatabase()


def prove_selection_cas(monkeypatch, drift):
    import asyncio

    from hushh_mcp.services.hosted_tier_guard import require_hosted_pilot_selection
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from tests.test_byoc_setup_job_azure_admission_postgres import ROOT, _Client, _server
    from tests.test_hosted_pilot_admission_postgres import _policy

    selection_runtime(monkeypatch)
    server = _server(monkeypatch, last=954)
    client = _Client(server)
    repo = PersonalAgentRegistryRepo(client=client)
    try:
        server.apply_file(ROOT / "db/migrations/parked/973_hosted_pod_pilot_admission.sql")
        _policy(server)
        server.execute(
            "INSERT INTO personal_agent_registry(user_id,hushh_id,status) "
            "VALUES ('owner-a','ha1_synthetic_hosted_owner_1','pending')"
        )
        admitted = asyncio.run(require_hosted_pilot_selection("owner-a", repo, require_record=True))
        if drift == "byoc":
            server.execute(
                "UPDATE personal_agent_registry SET deployment_target='user_gcp',"
                "user_cloud_project='synthetic-owner-cloud' WHERE user_id='owner-a'"
            )
        elif drift == "phase":
            asyncio.run(
                repo.claim_provision(
                    observed=admitted.registry_row,
                    intent={
                        "user_id": "owner-a",
                        "hushh_id": admitted.hushh_id,
                        "phone_e164_hash": "sha256:synthetic-phone-1",
                        "deployment_target": "gcp",
                        "model_credential_mode": "fleet_adc",
                    },
                )
            )
        before = server.execute(
            "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
        )[0][0]
        result = asyncio.run(
            repo.set_hosted_cloud(
                user_id="owner-a", deployment_target="gcp", expected_row=admitted.registry_row
            )
        )
        after = server.execute(
            "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
        )[0][0]
        assert result is (drift == "none")
        if drift == "none":
            assert after["deployment_target"] == "gcp"
            assert after["user_cloud_project"] is None
            assert after["model_credential_mode"] == before["model_credential_mode"]
        else:
            assert after == before
    finally:
        client._engine.dispose()
        server.stop()


def prove_policy_cannot_outlive_cleanup(monkeypatch, repo):
    import asyncio

    import pytest

    from hushh_mcp.services import hosted_engine_location_contract as locations
    from hushh_mcp.services.hosted_tier_guard import (
        HostedTierNotPermittedError,
        require_hosted_pilot_selection,
    )

    with monkeypatch.context() as shorter:
        shorter.setattr(
            locations,
            "provider_contract",
            lambda now: {
                "qualificationExpiresAt": (
                    datetime.now(timezone.utc) + timedelta(hours=1)
                ).isoformat()
            },
        )
        with pytest.raises(HostedTierNotPermittedError):
            asyncio.run(require_hosted_pilot_selection("owner-a", repo))
