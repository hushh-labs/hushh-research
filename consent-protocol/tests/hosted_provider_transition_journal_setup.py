"""Focused helpers for the retained hosted provider-account transition journal test."""

import hashlib
import json


def _set_test_environment(ctx):
    import psycopg2

    ctx.psycopg2 = psycopg2
    ctx.monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    ctx.monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.si")
    from tests.hosted_pilot_readiness_cases import (
        _apply_hosted_predecessor_migrations,
        _create_runtime_roles,
    )

    ctx._apply_hosted_predecessor_migrations = _apply_hosted_predecessor_migrations
    ctx._create_runtime_roles = _create_runtime_roles
    from tests.hosted_pod_support import (
        hosted_preparation_contract,
        hosted_project_authorization,
        preparation_results,
    )

    ctx.hosted_preparation_contract = hosted_preparation_contract
    ctx.hosted_project_authorization = hosted_project_authorization
    ctx.preparation_results = preparation_results
    from tests.test_hosted_pilot_admission_postgres import ROOT

    ctx.ROOT = ROOT
    from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

    ctx._approved_bootstrap = _approved_bootstrap
    ctx.image_digest = "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
    ctx.project_data = [
        {
            "owner": "owner-a",
            "hushhId": "ha1_t6cqxavpt6sumlllpfcjrwkh4fztw5zq",
            "project": "hussh-hp-7da5778b-261027a",
            "projectNumber": "1010592650891",
            "attemptId": "95af9d1fdab94601a1e45554e4774fd3",
            "operationId": "777fe0a3-eaa2-42b3-97d2-3b6549a20290",
            "serviceUid": "fec811ba-2456-495d-ab66-a0d926077ae1",
            "runtimePrincipal": "one-pod-ha1-t6cqxavpt-rkntchve@hussh-hp-7da5778b-261027a.iam.gserviceaccount.com",
        },
        {
            "owner": "owner-b",
            "hushhId": "ha1_sdhll3ua5kg4o6cmo2imyijcmygnwzqh",
            "project": "hussh-hp-a3a6730e-261027b",
            "projectNumber": "349132050484",
            "attemptId": "67ce0564b4b541a69abb31b336e51352",
            "operationId": "9df62f66-f271-491d-ab34-406823292f5d",
            "serviceUid": "e14040de-505a-4fc6-9a4a-e391ea1d6026",
            "runtimePrincipal": "one-pod-ha1-sdhll3ua5-rqghnwhy@hussh-hp-a3a6730e-261027b.iam.gserviceaccount.com",
        },
    ]
    _create_runtime_roles(ctx.pg)
    _apply_hosted_predecessor_migrations(ctx.pg, lambda: False)
    for ctx.migration in (
        "979_hosted_files_executor.sql",
        "980_personal_agent_upgrade_host_binding.sql",
        "981_hosted_native_location_contract.sql",
    ):
        ctx.pg.apply_file(ROOT / "db/migrations/parked" / ctx.migration)
    from db.hosted_custody_adoption import _successor_qualification

    ctx._successor_qualification = _successor_qualification
    ctx.pg.execute(_successor_qualification())
    from hushh_mcp.managed_ai_config import load_profile, profile_hash

    ctx.load_profile = load_profile
    ctx.profile_hash = profile_hash


def _seed_policy_and_reservations(ctx):
    ctx.profile = ctx.load_profile("dev")
    ctx.assignments = []
    ctx.contract = ctx.hosted_preparation_contract()
    ctx.contract["billingAccount"] = "billingAccounts/014D7F-FD970D-D2459E"
    for item in ctx.project_data:
        ctx.assignment = {
            "ownerHash": "sha256:" + hashlib.sha256(item["owner"].encode()).hexdigest(),
            "hushhId": item["hushhId"],
            "project": item["project"],
            "projectNumber": item["projectNumber"],
            "region": "us-central1",
            "preparationContract": ctx.contract,
        }
        ctx.assignment["bootstrapContract"] = ctx._approved_bootstrap(ctx.assignment)
        ctx.assignments.append(ctx.assignment)
    ctx.pg.execute(
        "INSERT INTO hosted_pod_pilot_policy(policy_id,environment,source_revision,image_digest,assignments,model_binding,work_budget_cents,cleanup_reserve_cents,created_at,expires_at) VALUES ('11111111-1111-4111-8111-111111111111','dev',%s,%s,%s::jsonb,%s::jsonb,40000,10000,now()-interval '2 days',now()+interval '1 day')",
        (
            "a" * 40,
            ctx.image_digest,
            json.dumps(ctx.assignments),
            json.dumps(
                {
                    "provider": "gemini",
                    "project": ctx.profile["project"],
                    "model": ctx.profile["text_model"],
                    "profileHash": ctx.profile_hash(ctx.profile),
                }
            ),
        ),
    )
    ctx.reservations = {}
    for item in ctx.project_data:
        ctx.desired = {
            "user_id": item["owner"],
            "hushh_id": item["hushhId"],
            "phone_e164_hash": "sha256:synthetic-" + item["owner"],
            "deployment_target": "gcp",
            "model_credential_mode": "fleet_adc",
        }
        ctx.reservations[item["owner"]] = ctx.pg.execute(
            "SELECT claim_hosted_pod_pilot_provision(%s,%s,NULL,%s::jsonb)",
            (item["owner"], item["attemptId"], json.dumps(ctx.desired)),
        )[0][0]


def _complete_retained_preparation(ctx, item, attempt):
    ctx.completed, ctx.identity = ctx.preparation_results(attempt)
    ctx.service_account = {
        "type": "gcp_service_account",
        "id": item["runtimePrincipal"],
        "disposition": "created",
        "identity": {
            "projectId": item["project"],
            "email": item["runtimePrincipal"],
            "name": f"projects/{item['project']}/serviceAccounts/{item['runtimePrincipal']}",
        },
    }
    attempt.setdefault("evidence", {}).setdefault("reserved", {})["hostedCheckpoint"] = {
        "completed": [
            {"step": "pod_service_account", "ok": True, "resourceObservation": ctx.service_account}
        ]
    }
    ctx.model_project = attempt["hostedAdmission"]["modelBinding"]["project"]
    ctx.completed.extend(
        (
            {
                "step": step,
                "status": 200,
                "ok": True,
                "resourceObservation": ctx.service_account,
                "bindingObservations": [
                    {
                        "step": step,
                        "policyResource": f"https://cloudresourcemanager.googleapis.com/v1/projects/{ctx.model_project}:getIamPolicy",
                        "role": role,
                        "member": f"serviceAccount:{item['runtimePrincipal']}",
                        "disposition": "added",
                        "beforeEtag": "before",
                        "afterEtag": "after",
                    }
                ],
            }
            for step, role in (
                ("inference_vertex", "roles/aiplatform.user"),
                ("inference_quota", "roles/serviceusage.serviceUsageConsumer"),
            )
        )
    )
    attempt["phase"] = "provisioned"
    attempt.setdefault("evidence", {}).setdefault("reserved", {})["projectObservation"] = {
        "projectId": item["project"],
        "projectNumber": item["projectNumber"],
        "lifecycleState": "ACTIVE",
    }
    attempt["evidence"]["reserved"]["projectAuthorization"] = ctx.hosted_project_authorization(
        attempt
    )
    attempt["evidence"]["reserved"]["hostedPreparation"] = {
        "version": 1,
        "ownerId": item["owner"],
        "attemptId": item["attemptId"],
        "generation": 10,
        "phase": "observed",
        "step": "inference_quota",
        "planDigest": attempt["hostedAdmission"]["preparationContractHash"],
        "completed": ctx.completed,
    }
    return ctx.completed


def _persist_retained_preparation(ctx, item, attempt, completed):
    ctx.row = ctx.pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (item["owner"],)
    )[0][0]
    ctx.metadata = ctx.row["backend_metadata"]
    ctx.metadata.update(
        {
            "tenancy": "hussh-hosted",
            "project": item["project"],
            "serviceUid": item["serviceUid"],
            "runtime_service_account": item["runtimePrincipal"],
            "provisionAttempt": attempt,
        }
    )
    ctx.pg.execute(
        "UPDATE personal_agent_registry SET status='provisioned',backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps(ctx.metadata), item["owner"]),
    )


def _seed_provisioned_rows(ctx):
    ctx.pg.execute("ALTER TABLE personal_agent_registry DISABLE TRIGGER USER")
    try:
        for item in ctx.project_data:
            attempt = ctx.reservations[item["owner"]]
            completed = _complete_retained_preparation(ctx, item, attempt)
            _persist_retained_preparation(ctx, item, attempt, completed)
    finally:
        ctx.pg.execute("ALTER TABLE personal_agent_registry ENABLE TRIGGER USER")
