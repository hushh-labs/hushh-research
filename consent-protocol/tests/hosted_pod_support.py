"""Public synthetic infrastructure facts for managed placement boundary tests."""

from __future__ import annotations

import hashlib

from hushh_mcp.services.gcp_backend import _service_name
from hushh_mcp.services.user_gcp_backend import pod_service_account_id


def hosted_registry_row(*, owner="owner-a", hushh_id="ha1_hosted_a", project="hussh-pilot-owner-a"):
    region, uid = "us-central1", "synthetic-service-uid-a"
    image = f"{region}-docker.pkg.dev/{project}/one-pod/consent-protocol-pod@sha256:" + "b" * 64
    admission = {
        "version": 1,
        "policyId": "11111111-1111-4111-8111-111111111111",
        "environment": "dev",
        "sourceRevision": "a" * 40,
        "imageDigest": "sha256:" + "b" * 64,
        "expiresAt": "2020-01-01T00:00:00+00:00",
        "modelBinding": {
            "provider": "gemini",
            "project": "hushh-gemini-bridge",
            "model": "gemini-synthetic",
            "profileHash": "c" * 64,
        },
        "assignment": {
            "ownerHash": "sha256:" + hashlib.sha256(owner.encode()).hexdigest(),
            "hushhId": hushh_id,
            "project": project,
            "projectNumber": None,
            "region": region,
            "bootstrapContract": {
                "plan": {
                    "federation": {
                        "impersonation": {
                            "bootstrap_service_account": f"one-bootstrap@{project}.iam.gserviceaccount.com"
                        }
                    }
                }
            },
        },
    }
    attempt = {
        "ownerId": owner,
        "attemptId": "d" * 32,
        "phase": "provisioned",
        "intent": {"user_id": owner, "hushh_id": hushh_id},
        "hostedAdmission": admission,
        "evidence": {
            "reserved": {
                "projectObservation": {
                    "projectId": project,
                    "projectNumber": "100000000001",
                    "lifecycleState": "ACTIVE",
                }
            },
            "host_requested": {
                "creationAcknowledgement": {
                    "backend": "gcp",
                    "project": project,
                    "region": region,
                    "service": _service_name(hushh_id),
                    "serviceUid": uid,
                    "initialGeneration": 1,
                    "initialImage": image,
                }
            },
        },
    }
    return {
        "user_id": owner,
        "hushh_id": hushh_id,
        "deployment_target": "gcp",
        "backend": "gcp",
        "status": "provisioned",
        "backend_metadata": {
            "tenancy": "hussh-hosted",
            "project": project,
            "region": region,
            "service": _service_name(hushh_id),
            "serviceUid": uid,
            "runtime_service_account": f"{pod_service_account_id(hushh_id)}@{project}.iam.gserviceaccount.com",
            "provisionAttempt": attempt,
        },
    }


def hosted_project_authorization(reservation):
    """Synthetic, stripped receipt in the real keyless authorization contract."""
    assignment = reservation["hostedAdmission"]["assignment"]
    project = assignment["project"]
    federation = assignment["bootstrapContract"]["plan"]["federation"]["impersonation"]
    bootstrap, caller = federation["bootstrap_service_account"], federation["granted_to"]
    return {
        "intent": {
            "ownerId": reservation["ownerId"],
            "jobId": reservation["attemptId"],
            "project": project,
            "callerEmail": caller,
        },
        "receipt": {
            "bootstrapIdentity": {
                "name": f"projects/{project}/serviceAccounts/{bootstrap}",
                "email": bootstrap,
                "projectId": project,
                "uniqueId": "123456789012345678901",
            },
            "bindingObservation": {
                "step": "authorize_bootstrap_impersonation",
                "policyResource": f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{bootstrap}:getIamPolicy",
                "role": "roles/iam.serviceAccountTokenCreator",
                "member": f"serviceAccount:{caller}",
                "disposition": "added",
                "beforeEtag": "before",
                "afterEtag": "after",
            },
        },
    }


def hosted_preparation_contract():
    return {
        "parentType": "folder",
        "parentId": "123456789",
        "billingAccount": "billingAccounts/000000-000000-000000",
        "operatorPrincipal": "user:operator@example.test",
        "projectedWorkCents": 10000,
        "steps": [
            "create_project",
            "link_billing",
            "authorize_project",
            "inference_vertex",
            "inference_quota",
        ],
    }


async def prepared_project_journal(pg, reservation, client, *, steps=3):
    """Synthetic provider receipts exercise the real preparation/projection SQL ports."""
    from hushh_mcp.services.hosted_pod_journal import HostedPodJournal

    results, identity = preparation_results(reservation)
    journal = HostedPodJournal(client)
    completed = []
    generation = 0
    for result in results[:steps]:
        checkpoint = {
            "version": 1,
            "ownerId": reservation["ownerId"],
            "attemptId": reservation["attemptId"],
            "expectedGeneration": generation,
            "generation": generation + 1,
            "planDigest": reservation["hostedAdmission"]["preparationContractHash"],
            "phase": "intent",
            "step": result["step"],
            "completed": list(completed),
        }
        assert await journal.publish(
            kind="preparation",
            owner_id=reservation["ownerId"],
            attempt_id=reservation["attemptId"],
            checkpoint=checkpoint,
        )
        completed.append(result)
        generation += 1
        assert await journal.publish(
            kind="preparation",
            owner_id=reservation["ownerId"],
            attempt_id=reservation["attemptId"],
            checkpoint={
                **checkpoint,
                "expectedGeneration": generation,
                "generation": generation + 1,
                "phase": "observed",
                "completed": list(completed),
            },
        )
        generation += 1
        if result["step"] == "create_project":
            assert await journal.retain_project(
                owner_id=reservation["ownerId"],
                attempt_id=reservation["attemptId"],
                observation={
                    key: identity[key] for key in ("projectId", "projectNumber", "lifecycleState")
                },
            )
    if steps == 3:
        assert await journal.retain_authorization(
            owner_id=reservation["ownerId"], attempt_id=reservation["attemptId"]
        )
    return pg.execute(
        "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id=%s",
        (reservation["ownerId"],),
    )[0][0]


def install_hosted_runtime(monkeypatch, *, owner="ha1_l6owner"):
    """A real validated hosted marker, without cloud credentials or calls."""
    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV, PrivateGcpDeployment

    profile = load_profile("dev")
    deployment = PrivateGcpDeployment(
        owner=owner,
        hosting_mode="hussh_hosted",
        environment="dev",
        project="hussh-pilot-owner01",
        region="us-central1",
        image="us-central1-docker.pkg.dev/hussh-pilot-owner01/one-pod/consent-protocol-pod@sha256:"
        + "a" * 64,
        hub_principal="consent-plane@hushh-pda-dev.iam.gserviceaccount.com",
        inference_project=profile["project"],
        inference_model=profile["text_model"],
        inference_profile_hash=profile_hash(profile),
    )
    for key in (
        "HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON",
        "HUSSH_POD_LOG_KEY",
        "HUSSH_POD_MEMORY_KEY",
        "HUSSH_POD_KEY_MASTER",
        "HUSSH_POD_KEY_MASTER_B64",
        "HUSSH_POD_MANAGED_MODEL_ENABLED",
        "GCE_METADATA_HOST",
        "GCE_METADATA_ROOT",
        "GCE_METADATA_IP",
        "HUSSH_POD_KEY_VAULT_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in {
        "HUSSH_POD_MODE": "true",
        "HUSSH_ID": owner,
        "HUSHH_DEPLOY_ENV": "dev",
        "K_SERVICE": "one-pod-hosted",
        "GOOGLE_CLOUD_PROJECT": deployment.project,
        "HUSSH_POD_KMS_KEY": deployment.kms_key,
        "POD_STORAGE_GCS_BUCKET": deployment.bucket,
        "HUSSH_POD_USER_ADC_ENABLED": "false",
        "HUSHH_GEMINI_TEXT_MODEL": deployment.inference_model,
        HOSTING_ENV: deployment.encoded(),
    }.items():
        monkeypatch.setenv(key, value)
    return deployment


def preparation_results(reservation):
    """Synthetic observed provider contracts; no provider calls."""
    assignment = reservation["hostedAdmission"]["assignment"]
    contract = assignment["preparationContract"]
    project = assignment["project"]
    identity = {
        "projectId": project,
        "projectNumber": assignment["projectNumber"],
        "lifecycleState": "ACTIVE",
        "parent": {"type": contract["parentType"], "id": contract["parentId"]},
        "labels": {
            "created-by": "hussh-one",
            "tenancy": "hussh-hosted",
            "hussh-environment": "dev",
            "hussh-provision-attempt": reservation["attemptId"],
        },
    }
    results = [
        {
            "step": "create_project",
            "status": 200,
            "ok": True,
            "resourceObservation": {
                "type": "gcp_project",
                "id": project,
                "disposition": "created",
                "identity": identity,
            },
        },
        {
            "step": "link_billing",
            "status": 200,
            "ok": True,
            "billingObservation": {
                "projectId": project,
                "billingAccountName": contract["billingAccount"],
                "billingEnabled": True,
            },
        },
        {
            "step": "authorize_project",
            "status": 200,
            "ok": True,
            "authorizationReceipt": hosted_project_authorization(reservation)["receipt"],
        },
    ]
    return results, identity


def historical_cleanup_snapshot():
    """Retained assignment predating the current inference approval."""
    row = hosted_registry_row()
    federation = row["backend_metadata"]["provisionAttempt"]["hostedAdmission"]["assignment"][
        "bootstrapContract"
    ]["plan"]["federation"]["impersonation"]
    federation["granted_to"] = "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    return row


def unqualified_cleanup_authorities(authority):
    """Only an exact, typed cleanup/inspect binding may retain the frozen profile."""
    from dataclasses import replace

    class DuckAuthority:
        operation = "cleanup"
        deployment = authority.deployment

        def __call__(self):
            raise AssertionError("constructor must not request provider authority")

    return (
        None,
        DuckAuthority(),
        replace(authority, operation="bootstrap"),
        replace(authority, operation="provision"),
        replace(authority, operation="upgrade"),
        replace(authority, deployment=replace(authority.deployment, service_uid="other-uid")),
    )


def assert_current_profile_required(authority):
    """Exercise the base constructor so wrapper checks cannot mask a widened boundary."""
    import pytest

    deployment = authority.deployment
    for candidate in unqualified_cleanup_authorities(authority):
        with pytest.raises(ValueError, match="approved dev profile"):
            from hushh_mcp.services.user_gcp_backend import UserGcpBackend

            UserGcpBackend(
                user_project=deployment.project,
                user_region=deployment.region,
                hushh_invoker_sa=deployment.hub_principal,
                hushh_id=deployment.owner,
                private_deployment=deployment,
                require_private_admission=candidate,
            )
