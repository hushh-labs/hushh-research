"""Read native facts for a never-hosted managed prefix; SQL owns admission."""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any, cast

from hushh_mcp.services.byoc_oauth_authorizer import _check
from hushh_mcp.services.hosted_native_inventory import NativeProjectInventory
from hushh_mcp.services.hosted_native_memory_inventory import observe_memory_absence
from hushh_mcp.services.hosted_prefix_native_resources import PrefixNativeResources
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class NativePrefixInventory:
    def __init__(self, registry: Any, *, token: str) -> None:
        if not token:
            raise ProvisionReconciliationRequired("Prefix inventory credential unavailable")
        self.registry, self.token = registry, token

    def __call__(self, reservation: dict, stage: str, session: Any) -> dict:
        if stage not in {"admission", "inventory"}:
            raise ValueError("Unsupported native prefix inventory stage")
        facts = self._facts(reservation)
        c = facts["context"]
        project, number, region = (c[key] for key in ("project", "projectNumber", "region"))
        attempt = reservation["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        creation = attempt["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
            "resourceObservation"
        ]["identity"]
        reader = NativeProjectInventory(
            project=project, number=number, token=self.token, session=session
        )
        reader.project_identity(creation)
        native = PrefixNativeResources(
            project=project, number=number, region=region, token=self.token, session=session
        )
        resources, writer = self._resources(native, c, facts["resources"], stage)
        self._core(reader.core(), resources, project, number)
        memory = observe_memory_absence(
            reader, assigned_region=region, creation=creation, managed_context=reservation
        )
        checks = self._failed_bindings(native, facts["failedBindingChecks"])
        service = next(
            item["nativeName"] for item in facts["resources"] if item["type"] == "cloud_run_service"
        )
        receipt = {
            "ownerId": reservation["ownerId"],
            "attemptId": reservation["attemptId"],
            "provisionAttemptId": c["provisionAttemptId"],
            "project": project,
            "projectNumber": number,
            "bootstrapGeneration": c["bootstrapGeneration"],
            "preparationGeneration": c["preparationGeneration"],
            "noHost": {
                "serviceName": service,
                "projectNumber": number,
                "httpStatus": 404,
                "status": "observed_absent",
            },
            "noMemory": memory,
            "writerFence": writer,
            "resources": resources,
            "bindings": facts["bindings"],
            "failedBindingChecks": checks,
        }
        reader.project_identity(creation)
        return self._freeze(reservation, receipt, stage)

    def _facts(self, reservation: dict) -> dict:
        response = self.registry._db().execute_raw(
            "WITH context AS (SELECT public.managed_prefix_abort_context(CAST(:r AS jsonb)) AS c) "
            "SELECT c AS context, public.managed_prefix_bindings(CAST(:r AS jsonb)) AS bindings, "
            'public.managed_prefix_failed_binding_checks(CAST(:r AS jsonb)) AS "failedBindingChecks", '
            "(SELECT jsonb_agg(x||jsonb_build_object('sourceStep',public.managed_prefix_resource_step(x->>'type'),"
            "'nativeName',public.managed_prefix_resource_name(c,x))) FROM jsonb_array_elements(c->'plan'->'resources') x) AS resources FROM context",
            {"r": json.dumps(reservation)},
        )
        if (
            not response.data
            or len(response.data) != 1
            or not isinstance(response.data[0].get("context"), dict)
        ):
            raise ProvisionReconciliationRequired("Prefix inventory lacks retained coordinates")
        facts = response.data[0]
        if any(
            not isinstance(facts.get(key), list)
            for key in ("resources", "bindings", "failedBindingChecks")
        ):
            raise ProvisionReconciliationRequired("Prefix inventory contract is incomplete")
        return cast(dict, facts)

    @staticmethod
    def _resources(
        native: PrefixNativeResources, c: dict, items: list[dict], stage: str
    ) -> tuple[list[dict], dict]:
        completed = {entry["step"]: entry for entry in c["bootstrapCompleted"]}
        resources, writer = [], None
        for item in items:
            step = item["sourceStep"]
            result = completed.get(step)
            entry = {key: item[key] for key in ("type", "id", "sourceStep")}
            if result is not None and result.get("ok") is True:
                entry.update(
                    disposition="created", identity=result["resourceObservation"]["identity"]
                )
            else:
                entry.update(
                    disposition="not_created",
                    absence={
                        "name": item["nativeName"],
                        "projectNumber": c["projectNumber"],
                        "httpStatus": 404,
                        "status": "observed_absent",
                    },
                )
                if result is not None:
                    entry.update(
                        disposition="confirmed_absent",
                        failedStep=step,
                        failedStatus=result["status"],
                    )
            body = native.observe(entry)
            if entry["disposition"] == "created" and body is None:
                raise ProvisionReconciliationRequired(
                    "Retained resource disappeared before inventory"
                )
            if item["type"] == "service_account":
                writer = NativePrefixInventory._writer(entry, body, c["projectNumber"], stage)
            resources.append(entry)
        if writer is None:
            raise ProvisionReconciliationRequired("Prefix writer inventory is missing")
        return resources, writer

    @staticmethod
    def _writer(item: dict, body: dict | None, number: str, stage: str) -> dict:
        if item["disposition"] == "created":
            if stage == "inventory" and (body or {}).get("disabled") is not True:
                raise ProvisionReconciliationRequired("Native prefix writer is not disabled")
            return {
                "status": "admitted" if stage == "admission" else "disabled",
                "identity": item["identity"],
            }
        receipt = {
            "status": item["disposition"],
            "serviceAccount": item["id"],
            "projectNumber": number,
        }
        if item["disposition"] == "confirmed_absent":
            receipt.update(failedStep=item["failedStep"], failedStatus=item["failedStatus"])
        return receipt

    @staticmethod
    def _core(inventory: dict, resources: list[dict], project: str, number: str) -> None:
        fields = {"gcs_bucket": "buckets", "kms_key": "kms_keys", "secret": "secrets"}
        expected: dict[str, set[str]] = {
            key: set()
            for key in (
                "cloud_run_services",
                "cloud_run_jobs",
                "buckets",
                "soft_deleted_buckets",
                "kms_keys",
                "secrets",
            )
        }

        def normalize(name: str) -> str:
            return name.replace(f"projects/{number}/", f"projects/{project}/", 1)

        for item in resources:
            if item["disposition"] == "created" and item["type"] in fields:
                expected[fields[item["type"]]].add(normalize(item["identity"]["name"]))
        if set(inventory) != set(expected):
            raise ProvisionReconciliationRequired("Native prefix inventory categories changed")
        for field, names in expected.items():
            actual = [normalize(entry.get("name", "")) for entry in inventory[field]]
            if len(set(actual)) != len(actual) or set(actual) != names:
                raise ProvisionReconciliationRequired(
                    "Native prefix contains unknown or missing resources"
                )

    @staticmethod
    def _failed_bindings(native: PrefixNativeResources, checks: list[dict]) -> list[dict]:
        for check in checks:
            url = check["policyResource"]
            post = url.startswith(
                ("https://iam.googleapis.com/", "https://cloudresourcemanager.googleapis.com/")
            )
            options = (
                {"json": {"options": {"requestedPolicyVersion": 3}}}
                if post
                else {"params": {"options.requestedPolicyVersion": 3}}
            )
            policy = _check(
                native.request("POST" if post else "GET", url, **options),
                "observe failed prefix grant",
            )
            rows = policy.get("bindings", [])
            if not isinstance(rows, list) or any(
                not isinstance(row, dict) or not isinstance(row.get("members", []), list)
                for row in rows
            ):
                raise ProvisionReconciliationRequired("Failed prefix IAM inventory is incomplete")
            for row in rows:
                if row.get("role") == check["role"] and any(
                    member == check["member"]
                    or member.startswith("deleted:" + check["member"] + "?uid=")
                    for member in row.get("members", [])
                ):
                    raise ProvisionReconciliationRequired(
                        "Failed prefix IAM effect requires reconciliation"
                    )
        return deepcopy(checks)

    @staticmethod
    def _freeze(reservation: dict, receipt: dict, stage: str) -> dict:
        if stage == "admission":
            return receipt
        prior = deepcopy(reservation.get("managedPrefixAbort", {}).get("inventoryAdmission"))
        if not isinstance(prior, dict):
            raise ProvisionReconciliationRequired("Prefix inventory admission is unavailable")

        def coverage(memory: dict) -> dict:
            return {
                **memory,
                "coverage": [
                    {k: v for k, v in row.items() if k != "observedAt"}
                    for row in memory["coverage"]
                ],
            }

        # Preserve actual first-observation times only after fresh native coverage
        # matches; never manufacture an updated timestamp for the retained receipt.
        if coverage(prior["noMemory"]) != coverage(receipt["noMemory"]):
            raise ProvisionReconciliationRequired("Native memory coverage changed while fencing")
        receipt["noMemory"] = prior["noMemory"]
        expected = deepcopy(prior)
        if expected["writerFence"]["status"] == "admitted":
            expected["writerFence"]["status"] = "disabled"
        if receipt != expected:
            raise ProvisionReconciliationRequired("Prefix inventory changed while fencing")
        return receipt
