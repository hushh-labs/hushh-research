"""Real SQL prefix-abort receipts; synthetic provider facts, no cloud calls."""

from __future__ import annotations

import json
from copy import deepcopy

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_project_preparation import prepare_project_step
from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap
from tests.fixtures.hosted_erasure import HostedErasure
from tests.hosted_pod_support import prepared_project_journal
from tests.test_hosted_pilot_admission_postgres import ROOT, _claim, _Client, _policy
from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap

RESOURCE_STEPS = {
    "artifact_repo": "artifact_repository",
    "kms_key": "kms_key",
    "pod_service_account": "service_account",
    "cmek_bucket": "gcs_bucket",
    "pod_signing_secret": "secret",
}


def binding_results(call, number):
    if call.get("kind") != "merge_binding":
        return []
    results = []
    for binding in call["bindings"]:
        members = binding["members"]
        if not members:
            members = [
                f"serviceAccount:service-{number}@serverless-robot-prod.iam.gserviceaccount.com"
                if call["step"] == "artifact_repo_grant_run_agent_reader"
                else f"serviceAccount:service-{number}@gs-project-accounts.iam.gserviceaccount.com"
            ]
        for member in members:
            results.append(
                {
                    "step": call["step"],
                    "policyResource": call["read_url"],
                    "role": binding["role"],
                    "member": member,
                    "disposition": "added",
                    "beforeEtag": "before",
                    "afterEtag": "after",
                }
            )
    return results


def project_wide_memory_absence(number, region):
    catalogue = sorted({region, "europe-west1", "us", "eu"})
    locations = sorted({*catalogue, "global"})
    return {
        "projectNumber": number,
        "locations": locations,
        "engines": [],
        "complete": True,
        "status": "observed_absent",
        "locationCatalogue": {
            "projectNumber": number,
            "locations": catalogue,
            "paginationComplete": True,
        },
        "coverage": [
            {
                "location": location,
                "status": "listed_empty",
                "apiVersion": "v1beta1",
                "observedAt": "2026-10-27T00:00:00Z",
                "projectNumber": number,
                "pages": 1,
            }
            for location in locations
        ],
    }


class HostedPrefixAbort(HostedErasure):
    """Retain every entered step, then abort without a pretend service UID."""

    async def prepare_prefix(self, client, count, *, substrate=False, bridge=False, reserve=True):
        retained = await prepared_project_journal(self.pg, self.provision, client, steps=3)
        contract = retained["hostedAdmission"]["assignment"]["bootstrapContract"]
        assert len(contract["steps"]) == 18  # Keep the every-prefix parameter matrix honest.
        number = retained["hostedAdmission"]["assignment"]["projectNumber"]
        bootstrap = self.plan["federation"]["impersonation"]["bootstrap_service_account"]
        calls = UserGcpBootstrap(
            project=self.project, region=self.region, bootstrap_sa=bootstrap
        ).plan_calls(self.plan)
        completed = []
        self.entered_bindings = []
        journal = HostedPodJournal(client)
        for index, call in enumerate(calls[:count]):
            step = call["step"]
            cp = {
                "version": 1,
                "ownerId": self.owner,
                "attemptId": self.provision["attemptId"],
                "planDigest": retained["hostedAdmission"]["bootstrapContractHash"],
                "step": step,
            }
            assert await journal.publish(
                kind="bootstrap",
                owner_id=self.owner,
                attempt_id=self.provision["attemptId"],
                checkpoint={
                    **cp,
                    "phase": "intent",
                    "expectedGeneration": index * 2,
                    "generation": index * 2 + 1,
                    "completed": deepcopy(completed),
                },
            )
            result = {"step": step, "status": 200, "ok": True}
            if step in RESOURCE_STEPS:
                result["resourceObservation"] = self.observations[RESOURCE_STEPS[step]]
            if bindings := binding_results(call, number):
                result["bindingObservations"] = bindings
                self.entered_bindings.extend(bindings)
            completed.append(result)
            assert await journal.publish(
                kind="bootstrap",
                owner_id=self.owner,
                attempt_id=self.provision["attemptId"],
                checkpoint={
                    **cp,
                    "phase": "observed",
                    "expectedGeneration": index * 2 + 1,
                    "generation": index * 2 + 2,
                    "completed": deepcopy(completed),
                },
            )
        if bridge:
            await prepare_bridge(self, journal)
        if substrate:
            assert self.pg.execute(
                "SELECT publish_personal_agent_provision(%s,%s,'reserved','substrate','{}'::jsonb)",
                (self.owner, self.provision["attemptId"]),
            )[0][0]
        if reserve:
            self.pg.execute(
                "SELECT reserve_personal_agent_erasure(%s,%s)", (self.owner, self.erase)
            )

    def native_inventory(self):
        r = self.reservation()
        original = r["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        checkpoint = original["evidence"]["reserved"].get("hostedCheckpoint", {})
        completed = {value["step"]: value for value in checkpoint.get("completed", [])}
        number = original["evidence"]["reserved"]["projectObservation"]["projectNumber"]
        resources = []
        for item in self.plan["resources"]:
            kind, rid = item["type"], item["id"]
            step = next(
                (key for key, value in RESOURCE_STEPS.items() if value == kind), "host_creation"
            )
            entry = {"type": kind, "id": rid, "sourceStep": step}
            if step in completed and completed[step]["ok"]:
                entry.update(disposition="created", identity=self.observations[kind]["identity"])
            else:
                name = self.pg.execute(
                    "SELECT managed_prefix_resource_name(erasure_private_coordinates(%s::jsonb),%s::jsonb)",
                    (json.dumps(r), json.dumps(item)),
                )[0][0]
                entry.update(
                    disposition="not_created",
                    absence={
                        "name": name,
                        "projectNumber": number,
                        "httpStatus": 404,
                        "status": "observed_absent",
                    },
                )
                if step in completed:
                    entry.update(
                        disposition="confirmed_absent",
                        failedStep=step,
                        failedStatus=completed[step]["status"],
                    )
            resources.append(entry)
        account = next(item for item in resources if item["type"] == "service_account")
        writer = (
            {"status": "disabled", "identity": self.runtime}
            if account["disposition"] == "created"
            else {"status": "not_created", "serviceAccount": account["id"], "projectNumber": number}
        )
        if account["disposition"] == "confirmed_absent":
            writer.update(
                status="confirmed_absent",
                failedStep=account["failedStep"],
                failedStatus=account["failedStatus"],
            )
        return {
            "ownerId": self.owner,
            "attemptId": self.erase,
            "provisionAttemptId": self.provision["attemptId"],
            "project": self.project,
            "projectNumber": number,
            "bootstrapGeneration": checkpoint.get("generation", 0),
            "preparationGeneration": original["evidence"]["reserved"]["hostedPreparation"][
                "generation"
            ],
            "noHost": {
                "serviceName": f"projects/{self.project}/locations/{self.region}/services/{self.service}",
                "projectNumber": number,
                "httpStatus": 404,
                "status": "observed_absent",
            },
            "noMemory": project_wide_memory_absence(number, self.region),
            "writerFence": writer,
            "resources": resources,
            "bindings": self.entered_bindings,
            "failedBindingChecks": getattr(self, "failed_binding_checks", []),
        }

    def retain_abort(self, kind, key, stage, receipt, *, owner=None, expected=None):
        return self.pg.execute(
            "SELECT retain_managed_prefix_abort(%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb)",
            (
                owner or self.owner,
                self.erase,
                json.dumps(self.reservation() if expected is None else expected),
                kind,
                key,
                stage,
                json.dumps(receipt),
            ),
        )[0][0]

    def prefix_base(self, **extra):
        inventory = self.reservation()["managedPrefixAbort"]["inventory"]
        digest = self.pg.execute(
            "SELECT encode(digest((%s::jsonb)::text,'sha256'),'hex')", (json.dumps(inventory),)
        )[0][0]
        return {
            "ownerId": self.owner,
            "attemptId": self.erase,
            "provisionAttemptId": self.provision["attemptId"],
            "inventoryHash": digest,
            **extra,
        }

    def freeze_inventory(self):
        inventory = self.native_inventory()
        intent = deepcopy(inventory)
        if intent["writerFence"]["status"] == "disabled":
            intent["writerFence"]["status"] = "admitted"
        before = self.reservation()
        assert not self.retain_abort("inventory", "", "inventory", inventory)
        assert not self.retain_abort("inventory", "", "admission", intent, owner="owner-b")
        assert self.reservation() == before
        assert self.retain_abort("inventory", "", "admission", intent)
        assert self.retain_abort("inventory", "", "admission", intent)  # Lost response / restart.
        assert not self.retain_abort("inventory", "", "inventory", inventory, expected=before)
        assert self.retain_abort("inventory", "", "inventory", inventory)
        return inventory

    def erase_prefix_items(self, inventory):
        for binding in inventory["bindings"]:
            key = self.pg.execute(
                "SELECT encode(digest((%s::jsonb)::text,'sha256'),'hex')", (json.dumps(binding),)
            )[0][0]
            admitted = self.prefix_base(binding=binding, status="admitted")
            assert self.retain_abort("bindings", key, "admission", admitted)
            assert self.retain_abort(
                "bindings", key, "deletion", {**admitted, "status": "observed_absent"}
            )
        for resource in inventory["resources"]:
            if resource["type"] == "kms_key" and resource["disposition"] == "created":
                key = resource["type"] + ":" + resource["id"]
                premature = self.prefix_base(
                    resource=resource,
                    status="admitted",
                    versionNames=[resource["identity"]["name"] + "/cryptoKeyVersions/1"],
                    paginationComplete=True,
                )
                assert not self.retain_abort("resources", key, "admission", premature)
        for resource in sorted(
            inventory["resources"],
            key=lambda item: item["type"] == "kms_key" and item["disposition"] == "created",
        ):
            key = resource["type"] + ":" + resource["id"]
            admitted = self.prefix_base(resource=resource, status="admitted")
            if resource["type"] == "kms_key" and resource["disposition"] == "created":
                admitted.update(
                    versionNames=[resource["identity"]["name"] + "/cryptoKeyVersions/1"],
                    paginationComplete=True,
                )
            assert self.retain_abort("resources", key, "admission", admitted)
            status = (
                resource["disposition"]
                if resource["disposition"] in {"not_created", "confirmed_absent"}
                else "observed_absent"
            )
            deleted = {**admitted, "status": status}
            if "versionNames" in admitted:
                deleted.update(
                    status="destroyed",
                    destroyedVersions=[{"name": admitted["versionNames"][0], "state": "DESTROYED"}],
                )
                pending = {
                    **deleted,
                    "destroyedVersions": [
                        {"name": admitted["versionNames"][0], "state": "DESTROY_SCHEDULED"}
                    ],
                }
                assert not self.retain_abort("resources", key, "deletion", pending)
            assert self.retain_abort("resources", key, "deletion", deleted)
            assert self.retain_abort("resources", key, "deletion", deleted)


async def admitted_prefix_abort(pg, count, *, substrate=False, bridge=False, reserve=True):
    for number in (956, 957, 960, 961, 962, 963, 964, 972):
        pg.apply_file(next((ROOT / "db/migrations/parked").glob(f"{number}_*.sql")))
    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    _policy(pg, bootstrap=_approved_bootstrap, preparation=True)
    fixture = HostedPrefixAbort(pg, _claim(pg))
    client = _Client(pg)
    try:
        await fixture.prepare_prefix(
            client, count, substrate=substrate, bridge=bridge, reserve=reserve
        )
        yield fixture
    finally:
        client._engine.dispose()


def retire_prefix(fixture):
    original = fixture.reservation()["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
    admitted = fixture.prefix_base(
        authorization=original["evidence"]["reserved"]["projectAuthorization"]["receipt"],
        status="admitted",
    )
    assert fixture.retain_abort("bootstrap", "bootstrap", "admission", admitted)
    assert fixture.retain_abort(
        "bootstrap", "bootstrap", "deletion", {**admitted, "status": "observed_absent"}
    )
    assignment = original["hostedAdmission"]["assignment"]
    creation = original["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
        "resourceObservation"
    ]["identity"]
    admitted = fixture.prefix_base(
        project=fixture.project,
        projectNumber=creation["projectNumber"],
        operatorPrincipal=assignment["preparationContract"]["operatorPrincipal"],
        status="admitted",
    )
    assert fixture.retain_abort("retirement", "project", "admission", admitted)
    deleted = {
        **admitted,
        "status": "retirement_pending_provider_purge",
        "projectIdentity": {**creation, "lifecycleState": "DELETE_REQUESTED"},
        "billingObservation": {
            "projectId": fixture.project,
            "billingAccountName": "",
            "billingEnabled": False,
        },
    }
    assert fixture.retain_abort("retirement", "project", "deletion", deleted)


async def prepare_bridge(self, journal):
    for kind, binding in zip(("vertex", "quota"), self.bindings[:2], strict=True):
        retained = self.row()["backend_metadata"]["provisionAttempt"]
        binding = {
            **binding,
            "step": "inference_" + kind,
            "policyResource": "https://cloudresourcemanager.googleapis.com/v1/projects/"
            + retained["hostedAdmission"]["modelBinding"]["project"]
            + ":getIamPolicy",
        }
        result = {
            "step": "inference_" + kind,
            "status": 200,
            "ok": True,
            "resourceObservation": self.observations["service_account"],
            "bindingObservations": [binding],
        }

        async def observed(result=result):
            return result

        await prepare_project_step(
            journal, retained, step=result["step"], mutate=observed, observe=observed
        )
        self.entered_bindings.append(binding)


async def verify_memory_inventory(pg):
    async for fixture in admitted_prefix_abort(pg, 0):
        inventory = fixture.native_inventory()

        def valid(value, fixture=fixture):
            return pg.execute(
                "SELECT valid_managed_prefix_inventory_admission(%s::jsonb,%s::jsonb)",
                (json.dumps(fixture.reservation()), json.dumps(value)),
            )[0][0]

        assert valid(inventory)
        unsupported = deepcopy(inventory)
        scope = unsupported["noMemory"]["coverage"][0]
        del scope["pages"]
        scope.update(
            status="unsupported",
            httpStatus=400,
            errorCode=400,
            errorStatus="INVALID_ARGUMENT",
            messageSha256="a" * 64,
        )
        assert not valid(unsupported)  # Provider errors never establish absence.
        forbidden = deepcopy(unsupported)
        forbidden["noMemory"]["coverage"][0]["httpStatus"] = 403
        incomplete = deepcopy(inventory)
        incomplete["noMemory"]["coverage"].pop()
        unpaged = deepcopy(inventory)
        unpaged["noMemory"]["locationCatalogue"]["paginationComplete"] = False
        wrong_project = deepcopy(inventory)
        wrong_project["noMemory"]["coverage"][0]["projectNumber"] = "999999999999"
        for value in (forbidden, incomplete, unpaged, wrong_project):
            assert not valid(value)
        assert "managedPrefixAbort" not in fixture.reservation()
