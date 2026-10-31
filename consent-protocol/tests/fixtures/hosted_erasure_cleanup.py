"""Owner-bound resource cleanup transitions for the managed PostgreSQL fixture."""

from __future__ import annotations

import json
from copy import deepcopy

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal


class HostedErasureCleanup:
    """Compose validated resource transitions with the fixture's retained SQL ports."""

    def destroy_owner_resources(self):
        bucket = self.base(
            bucketIdentity=self.observations["gcs_bucket"]["identity"], metageneration="4"
        )
        for stage, status in (
            ("bucketAdmission", "admitted"),
            ("bucketAcknowledgement", "acknowledged"),
            ("bucketDeletion", "deleted"),
        ):
            assert self.retain("retain_erasure_bucket_receipt", stage, {**bucket, "status": status})
        inventory = self.base(
            resourceObservation=self.observations["kms_key"],
            versionNames=[
                self.observations["kms_key"]["identity"]["name"] + "/cryptoKeyVersions/1"
            ],
        )
        self.reject_incomplete_kms_boundary(inventory)
        assert self.retain("retain_erasure_kms_receipt", "inventory", inventory)
        version = {key: value for key, value in inventory.items() if key != "versionNames"}
        version["versionName"] = inventory["versionNames"][0]
        for stage, status in (("admission", "admitted"), ("acknowledgement", "scheduled")):
            assert self.retain("retain_erasure_kms_receipt", stage, {**version, "status": status})
        assert not self.retain(
            "retain_erasure_kms_receipt", "completion", {**inventory, "status": "destroyed"}
        )
        assert self.retain(
            "retain_erasure_kms_receipt", "destruction", {**version, "status": "destroyed"}
        )
        assert self.retain(
            "retain_erasure_kms_receipt", "completion", {**inventory, "status": "destroyed"}
        )
        for kind, port in (
            ("secret", "retain_erasure_secret_receipt"),
            ("service_account", "retain_erasure_account_receipt"),
        ):
            base = self.base(resourceObservation=self.observations[kind])
            if kind == "secret":
                base["etag"] = "secret-etag"
            for stage, status in (
                ("admission", "admitted"),
                ("acknowledgement", "acknowledged"),
                ("deletion", "absent"),
            ):
                assert self.retain(port, stage, {**base, "status": status})

    def reject_incomplete_kms_boundary(self, inventory):
        """No-mail qualification cannot hide a missing or contradictory inventory."""
        original = self.reservation()
        missing = deepcopy(original)
        del missing["substrateInventory"]
        omitted = deepcopy(original)
        omitted["substrateInventory"]["plannedResources"] = [
            item
            for item in omitted["substrateInventory"]["plannedResources"]
            if item["type"] != "artifact_repository"
        ]
        candidates = [missing, omitted]
        for legacy_only in (False, True):
            declared = deepcopy(original)
            admission = declared["registrySnapshot"]["backend_metadata"]["provisionAttempt"][
                "hostedAdmission"
            ]
            contract = admission["assignment"]["bootstrapContract"]
            resource = {"type": "pubsub_topic", "id": "declared-mail"}
            if legacy_only:
                resource["legacyOnly"] = True
            contract["plan"]["resources"].append(resource)
            admission["bootstrapContractHash"] = self.pg.execute(
                "SELECT encode(digest((%s::jsonb)::text,'sha256'),'hex')", (json.dumps(contract),)
            )[0][0]
            candidates.append(declared)
        for candidate in candidates:
            assert not self.pg.execute(
                "SELECT valid_erasure_kms_receipt(%s::jsonb,'inventory',%s::jsonb)",
                (json.dumps(candidate), json.dumps(inventory)),
            )[0][0]
        assert self.reservation() == original

    def release_project_grants(self):
        assert self.pg.execute(
            "SELECT reserve_erasure_grant_release(%s,%s,%s::jsonb)",
            (self.owner, self.erase, json.dumps(self.reservation())),
        )[0][0]
        for binding in self.bindings[:2]:
            base = self.base(runtimeIdentity=self.runtime, bindingObservation=binding)
            for stage, status in (("admission", "admitted"), ("deletion", "observed_absent")):
                assert self.retain(
                    "retain_erasure_runtime_grant_receipt", stage, {**base, "status": status}
                )
        repository = self.observations["artifact_repository"]["identity"]
        base = self.base(repositoryIdentity=repository, bindingObservation=self.bindings[2])
        for stage, status in (("admission", "admitted"), ("deletion", "observed_absent")):
            assert self.retain(
                "retain_erasure_repository_grant_receipt", stage, {**base, "status": status}
            )
        inventory = self.base(
            repositoryIdentity=repository,
            images=[
                {
                    "name": repository["name"]
                    + "/dockerImages/consent-protocol-pod@"
                    + self.image.rsplit("@", 1)[1],
                    "uri": self.image,
                }
            ],
            paginationComplete=True,
            classification="unresolved",
        )
        assert self.pg.execute(
            "SELECT retain_erasure_repository_inventory(%s,%s,%s::jsonb,%s::jsonb)",
            (self.owner, self.erase, json.dumps(self.reservation()), json.dumps(inventory)),
        )[0][0]
        retained = self.base(
            repositoryIdentity=repository,
            disposition="retained_shared",
            reason="application_distribution_storage",
        )
        assert self.pg.execute(
            "SELECT retain_erasure_repository_retention(%s,%s,%s::jsonb,%s::jsonb)",
            (self.owner, self.erase, json.dumps(self.reservation()), json.dumps(retained)),
        )[0][0]

    def release_bootstrap(self):
        assert self.pg.execute(
            "SELECT reserve_erasure_bootstrap_grants(%s,%s,%s::jsonb,%s)",
            (self.owner, self.erase, json.dumps(self.reservation()), "serviceAccount:" + self.hub),
        )[0][0]
        release = self.reservation()["bootstrapGrantRelease"]
        for key, value in release["groups"].items():
            base = self.base(
                bootstrapIdentity=value["bootstrapIdentity"],
                bindingObservation=value["bindingObservation"],
            )
            for stage, status in (("admission", "admitted"), ("deletion", "observed_absent")):
                assert self.pg.execute(
                    "SELECT retain_erasure_bootstrap_grant_receipt(%s,%s,%s::jsonb,%s,%s,%s::jsonb)",
                    (
                        self.owner,
                        self.erase,
                        json.dumps(self.reservation()),
                        key,
                        stage,
                        json.dumps({**base, "status": status}),
                    ),
                )[0][0]

    async def retire(self, client):
        journal = HostedPodJournal(client)
        attempt = self.reservation()["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        creation = attempt["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
            "resourceObservation"
        ]["identity"]
        actor = attempt["hostedAdmission"]["assignment"]["preparationContract"]["operatorPrincipal"]
        base = self.base(
            project=self.project, projectNumber=creation["projectNumber"], operatorPrincipal=actor
        )
        receipts = (
            ("admission", {**base, "status": "admitted"}),
            (
                "deletion",
                {
                    **base,
                    "status": "retirement_pending_provider_purge",
                    "projectIdentity": {**creation, "lifecycleState": "DELETE_REQUESTED"},
                    "billingObservation": {
                        "projectId": self.project,
                        "billingAccountName": "",
                        "billingEnabled": False,
                    },
                },
            ),
        )
        for stage, receipt in receipts:
            before = self.reservation()
            assert not await journal.retain_managed_cleanup(
                owner_id="owner-b",
                reservation=before,
                kind="retirement",
                stage=stage,
                receipt=receipt,
            )
            assert self.reservation() == before
            assert await journal.retain_managed_cleanup(
                owner_id=self.owner,
                reservation=before,
                kind="retirement",
                stage=stage,
                receipt=receipt,
            )
