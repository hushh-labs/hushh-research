"""Synthetic provider facts driven through real managed lifecycle SQL ports."""

from __future__ import annotations

import json
from copy import deepcopy

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_project_preparation import prepare_project_step
from tests.fixtures.hosted_erasure_cleanup import HostedErasureCleanup
from tests.fixtures.hosted_erasure_resources import CREATED, HostedErasureFacts
from tests.hosted_pod_support import prepared_project_journal
from tests.test_hosted_pilot_admission_postgres import ROOT, _claim, _Client, _policy
from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap


class HostedErasure(HostedErasureCleanup, HostedErasureFacts):
    """Advance real guards; never create a BYOC setup/authorization row."""

    def row(self):
        return self.pg.execute(
            "SELECT to_jsonb(p) FROM personal_agent_registry p WHERE user_id=%s", (self.owner,)
        )[0][0]

    def reservation(self):
        return self.row()["backend_metadata"]["erasure"]

    def retain(self, port, stage, receipt):
        return self.pg.execute(
            f"SELECT {port}(%s,%s,%s::jsonb,%s,%s::jsonb)",
            (self.owner, self.erase, json.dumps(self.reservation()), stage, json.dumps(receipt)),
        )[0][0]

    def base(self, **extra):
        return {"ownerId": self.owner, "attemptId": self.erase, **extra}

    async def prepare(self, client):
        retained = await prepared_project_journal(self.pg, self.provision, client, steps=3)
        journal = HostedPodJournal(client)
        contract = retained["hostedAdmission"]["assignment"]["bootstrapContract"]
        resource_steps = {
            "artifact_repo": "artifact_repository",
            "kms_key": "kms_key",
            "pod_service_account": "service_account",
            "cmek_bucket": "gcs_bucket",
            "pod_signing_secret": "secret",
        }
        completed = []
        for index, step in enumerate(contract["steps"]):
            checkpoint = {
                "version": 1,
                "ownerId": self.owner,
                "attemptId": retained["attemptId"],
                "planDigest": retained["hostedAdmission"]["bootstrapContractHash"],
                "step": step,
            }
            assert await journal.publish(
                kind="bootstrap",
                owner_id=self.owner,
                attempt_id=retained["attemptId"],
                checkpoint={
                    **checkpoint,
                    "expectedGeneration": index * 2,
                    "generation": index * 2 + 1,
                    "phase": "intent",
                    "completed": deepcopy(completed),
                },
            )
            result = {"step": step, "status": 200, "ok": True}
            if step in resource_steps:
                result["resourceObservation"] = self.observations[resource_steps[step]]
            completed.append(result)
            assert await journal.publish(
                kind="bootstrap",
                owner_id=self.owner,
                attempt_id=retained["attemptId"],
                checkpoint={
                    **checkpoint,
                    "expectedGeneration": index * 2 + 1,
                    "generation": index * 2 + 2,
                    "phase": "observed",
                    "completed": deepcopy(completed),
                },
            )
        for kind, binding in zip(("vertex", "quota"), self.bindings[:2], strict=True):
            retained = self.row()["backend_metadata"]["provisionAttempt"]
            bridge = {
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
                "bindingObservations": [bridge],
            }

            async def observed(result=result):
                return result

            await prepare_project_step(
                journal, retained, step=result["step"], mutate=observed, observe=observed
            )

    def publish_host(self):
        phases = (
            "reserved",
            "substrate",
            "host_requested",
            "host_acknowledged",
            "connecting",
            "provisioned",
        )
        metadata = {
            "tenancy": "hussh-hosted",
            "project": self.project,
            "region": self.region,
            "service": self.service,
            "serviceUid": "incarnation",
            "url": "https://pod.example",
            "runtime_service_account": self.runtime["email"],
            "substrateReceipt": self.inventory,
        }
        ack = {
            "backend": "gcp",
            "project": self.project,
            "region": self.region,
            "service": self.service,
            "serviceUid": "incarnation",
            "initialGeneration": 1,
            "initialImage": self.image,
        }
        for before, after in zip(phases[:-1], phases[1:], strict=True):
            evidence = {
                "registry": {
                    "backend": "gcp",
                    "external_agent_id": self.service,
                    "backend_metadata": metadata,
                }
            }
            if after == "host_requested":
                evidence["creationAcknowledgement"] = ack
            assert self.pg.execute(
                "SELECT publish_personal_agent_provision(%s,%s,%s,%s,%s::jsonb)",
                (self.owner, self.provision["attemptId"], before, after, json.dumps(evidence)),
            )[0][0]
        self.pg.execute("SELECT reserve_personal_agent_erasure(%s,%s)", (self.owner, self.erase))

    def memory_compute_writer(self):
        memory = {
            "hushhId": self.provision["intent"]["hushh_id"],
            "attemptId": self.erase,
            "service": self.service,
            "serviceUid": "incarnation",
            "revision": self.service + "-v1",
            "memoryBinding": {
                "project": self.project,
                "location": self.region,
                "engineId": "91",
                "generationProtocol": 2,
                "engineIncarnation": {
                    "name": f"projects/{self.project}/locations/{self.region}/reasoningEngines/91",
                    "createTime": CREATED,
                },
            },
        }
        memory["memoryBinding"]["creationProvenance"] = {
            "version": 1,
            "reservationGeneration": 1,
            "engineIncarnation": memory["memoryBinding"]["engineIncarnation"],
        }
        for port, receipt in (
            ("retain_erasure_memory_binding", memory),
            ("retain_erasure_memory_deletion", {**memory, "status": "provider_deleted"}),
        ):
            assert self.pg.execute(
                f"SELECT {port}(%s,%s,%s::jsonb,%s::jsonb)",
                (self.owner, self.erase, json.dumps(self.reservation()), json.dumps(receipt)),
            )[0][0]
        compute = {
            "serviceName": f"projects/{self.project}/locations/{self.region}/services/{self.service}",
            "serviceUid": "incarnation",
            "etag": "v1",
            "generation": 1,
            "image": self.image,
        }
        assert self.retain("retain_erasure_compute_receipt", "computeAdmission", compute)
        ack = {
            **compute,
            "operationName": f"projects/{self.project}/locations/{self.region}/operations/delete-1",
        }
        assert self.retain("retain_erasure_compute_receipt", "computeAcknowledgement", ack)
        assert self.retain(
            "retain_erasure_compute_receipt",
            "computeDeletion",
            {**ack, "status": "compute_deleted"},
        )
        assert self.pg.execute(
            "SELECT retain_erasure_substrate_inventory(%s,%s,%s::jsonb)",
            (self.owner, self.erase, json.dumps(self.reservation())),
        )[0][0]
        writer = self.base(runtimeIdentity=self.runtime, bootstrapIdentity=self.bootstrap)
        assert self.retain(
            "retain_erasure_writer_receipt", "writerAdmission", {**writer, "status": "admitted"}
        )
        assert self.retain(
            "retain_erasure_writer_receipt", "writerDisabled", {**writer, "status": "disabled"}
        )

    async def model_grants(self, client):
        journal = HostedPodJournal(client)
        completed = self.reservation()["registrySnapshot"]["backend_metadata"]["provisionAttempt"][
            "evidence"
        ]["reserved"]["hostedPreparation"]["completed"]
        for kind, result in zip(("vertex", "quota"), completed[3:], strict=True):
            base = self.base(
                provisionAttemptId=self.provision["attemptId"],
                runtimeIdentity=self.runtime,
                bindingObservation=result["bindingObservations"][0],
            )
            for stage, status in (("admission", "admitted"), ("deletion", "observed_absent")):
                before = self.reservation()
                assert not await journal.retain_managed_cleanup(
                    owner_id="owner-b",
                    reservation=before,
                    kind=kind,
                    stage=stage,
                    receipt={**base, "status": status},
                )
                assert self.reservation() == before
                assert await journal.retain_managed_cleanup(
                    owner_id=self.owner,
                    reservation=before,
                    kind=kind,
                    stage=stage,
                    receipt={**base, "status": status},
                )


async def admitted_erasure(pg):
    for number in (956, 957, 960, 961, 962, 963, 964, 972):
        pg.apply_file(next((ROOT / "db/migrations/parked").glob(f"{number}_*.sql")))
    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    _policy(pg, bootstrap=_approved_bootstrap, preparation=True)
    fixture = HostedErasure(pg, _claim(pg))
    client = _Client(pg)
    try:
        await fixture.prepare(client)
        fixture.publish_host()
        yield fixture, client
    finally:
        client._engine.dispose()
