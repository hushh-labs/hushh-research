"""Apply only an approved Files delta through the existing bootstrap executor."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan
from hushh_mcp.services.pod_files.provisioning import bootstrap_calls, bucket_matches
from hushh_mcp.services.user_gcp_bootstrap import BootstrapError, UserGcpBootstrap


class FilesCapabilityBootstrap(UserGcpBootstrap):
    def __init__(self, *, capability: FilesCapabilityPlan, **kwargs: Any) -> None:
        super().__init__(project=capability.project, region=capability.region, **kwargs)
        self._capability = capability

    def plan_calls(self, plan: dict[str, Any]) -> list[dict[str, Any]]:
        if plan != self._capability.substrate_plan():
            raise BootstrapError("Files activation plan changed")
        project, region = self._project, self._region
        service_iam = (
            f"https://{region}-run.googleapis.com/v1/projects/{project}"
            f"/locations/{region}/services/{self._capability.service}"
        )
        calls = [
            {
                "step": "enable_services",
                "method": "POST",
                "url": f"https://serviceusage.googleapis.com/v1/projects/{project}/services:batchEnable",
                "body": {"serviceIds": ["cloudtasks.googleapis.com"]},
                "tolerate": [],
                "await_operation": True,
                "operation_url": "https://serviceusage.googleapis.com/v1/",
                "gates_rest": True,
            },
            *bootstrap_calls(
                plan, project=project, region=region, runtime=self._capability.runtimeAccount
            ),
            {
                "step": "iam_files_invoker",
                "kind": "merge_binding",
                "depends_on": "files_worker_account",
                "read_method": "GET",
                "read_url": service_iam + ":getIamPolicy",
                "write_url": service_iam + ":setIamPolicy",
                "policy_envelope": "policy",
                "bindings": [
                    {
                        "role": "roles/run.invoker",
                        "members": ["serviceAccount:" + plan["filesLibrary"]["worker"]],
                    }
                ],
            },
        ]
        # This delta verifies the existing bucket before execution; it never
        # creates it or invents a successful creation receipt for a dependency.
        for call in calls:
            if call.get("step") == "iam_files_bucket_metadata":
                call.pop("depends_on", None)
        # Legacy bootstrap authorization predates Cloud Tasks. Its existing
        # project-IAM authority applies this explicitly approved, retained grant.
        calls.insert(
            3,
            {
                "step": "iam_files_queue_admin",
                "kind": "merge_binding",
                "read_method": "POST",
                "read_url": f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:getIamPolicy",
                "write_url": f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:setIamPolicy",
                "policy_envelope": "policy",
                "bindings": [
                    {
                        "role": "roles/cloudtasks.queueAdmin",
                        "members": ["serviceAccount:" + self._capability.bootstrapAccount],
                    }
                ],
            },
        )
        return calls

    def verify_existing_bucket(self) -> None:
        """Read custody before adding IAM; no bucket/prefix configuration is changed."""
        headers = {"Authorization": f"Bearer {self._token}"}
        project = self._session.get(
            f"https://cloudresourcemanager.googleapis.com/v1/projects/{self._project}",
            headers=headers,
            timeout=30,
            allow_redirects=False,
        )
        bucket = self._session.get(
            f"https://storage.googleapis.com/storage/v1/b/{self._capability.bucket}",
            headers=headers,
            timeout=30,
            allow_redirects=False,
        )
        if project.status_code != 200 or bucket.status_code != 200:
            raise BootstrapError("Files bucket custody cannot be verified")
        owner, observed = project.json(), bucket.json()
        number = owner.get("projectNumber")
        if (
            not isinstance(number, str)
            or not number.isdigit()
            or owner.get("projectId") != self._project
            or str(observed.get("projectNumber")) != number
            or not bucket_matches(
                observed, bucket=self._capability.bucket, kms_key=self._capability.kmsKey
            )
        ):
            raise BootstrapError("Files bucket custody changed")

    def apply_delta(self, *, checkpoint: Callable[[str, str, list[dict[str, Any]]], None]) -> dict:
        if not callable(checkpoint) or not self._token:
            raise BootstrapError("Files activation requires durable authority checkpoints")
        self.verify_existing_bucket()
        outcome = self.apply(
            self._capability.substrate_plan(), dry_run=False, checkpoint=checkpoint
        )
        if outcome.get("ok") is not True:
            # Qualified intent/results have already been retained by checkpoint.
            # Failed/unknown provider work requires reconciliation, never replay.
            raise BootstrapError("Files activation requires reconciliation")
        return outcome
