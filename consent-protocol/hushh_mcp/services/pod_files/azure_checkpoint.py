"""Bounded Azure Files evidence under the existing upgrade lease and CAS."""

from __future__ import annotations

from copy import deepcopy

from .azure_capability import AzureFilesCapabilityPlan


def qualify_readback(call: dict, value: dict) -> dict:
    """Discard provider response bodies; retain only the approved resource's configuration."""
    approved_path = call["path"].lower()
    allowed_ids = {approved_path}
    # ARM returns a subscription-canonical ID for a role created/read through
    # its resource-group scope. Derive only that exact ID from the approved plan;
    # GUID suffixes and aliases for other resource kinds are not authority.
    parts = approved_path.split("/")
    if (
        call["kind"] == "role_definition"
        and len(parts) == 9
        and parts[0] == ""
        and parts[1] == "subscriptions"
        and parts[3] == "resourcegroups"
        and parts[5:8] == ["providers", "microsoft.authorization", "roledefinitions"]
    ):
        allowed_ids.add(
            f"/subscriptions/{parts[2]}/providers/microsoft.authorization/roledefinitions/{parts[8]}"
        )
    if str(value.get("id", "")).lower() not in allowed_ids:
        raise ValueError("Files resource readback belongs to another resource")
    props = value.get("properties") or {}
    expected = call["body"]["properties"]
    if call["kind"] == "role_definition":
        permissions = props.get("permissions")
        if not isinstance(permissions, list) or len(permissions) != 1:
            raise ValueError("Files role permissions are not verified")
        permission = permissions[0]
        # ARM may include empty optional permission lists in readback.
        if (
            set(permission.get("actions", [])) != set(expected["permissions"][0]["actions"])
            or any(permission.get(name) for name in ("notActions", "dataActions", "notDataActions"))
            or {str(x).lower() for x in props.get("assignableScopes", [])}
            != {x.lower() for x in expected["assignableScopes"]}
            or props.get("type") != "CustomRole"
        ):
            raise ValueError("Files role permissions are not verified")
    elif call["kind"] == "role_assignment":
        if (
            any(
                str(props.get(name, "")).lower() != str(expected[name]).lower()
                for name in ("principalId", "roleDefinitionId")
            )
            or props.get("principalType") != "ServicePrincipal"
            or props.get("condition")
            or props.get("conditionVersion")
        ):
            raise ValueError("Files role assignment is not verified")
    elif call["step"] != "files_queue":
        raise ValueError("Files resource is outside the approved plan")
    return {"id": call["path"], "kind": call["kind"], "properties": deepcopy(expected)}


class AzureFilesUpgradeCheckpoint:
    inventory_key = "azureFilesInventory"

    def __init__(
        self,
        *,
        plan: AzureFilesCapabilityPlan,
        operation_id: str,
        attempt_id: str,
        original_inventory: dict,
        previous: dict | None = None,
    ):
        self.plan, self.operation_id, self.attempt_id = plan, operation_id, attempt_id
        self.calls = plan.operations()
        self.previous = deepcopy(previous)
        if previous is not None:
            if any(previous.get(key) != value for key, value in self._binding().items()):
                raise ValueError("Files checkpoint belongs to another approved operation")
            self._validate_prefix(previous.get("completed", []))
            completed = previous.get("completed", [])
            index = len(completed) - (previous.get("phase") in {"observed", "replacement_intent"})
            if (
                previous.get("phase") not in {"intent", "observed", "replacement_intent"}
                or not 0 <= index < len(self.calls)
                or previous.get("step") != self.calls[index]["step"]
                or (
                    previous.get("phase") == "replacement_intent"
                    and (len(completed) != len(self.calls) or not all(x["ok"] for x in completed))
                )
            ):
                raise ValueError("Files checkpoint sequence is invalid")

    def _binding(self) -> dict:
        return {
            "version": 2,
            "provider": "user_azure",
            "planDigest": self.plan.digest,
            "operationId": self.operation_id,
            "attemptId": self.attempt_id,
        }

    def _validate_prefix(self, completed: list[dict]) -> None:
        if not isinstance(completed, list) or len(completed) > len(self.calls):
            raise ValueError("Files observations exceed the approved plan")
        for index, result in enumerate(completed):
            call = self.calls[index]
            if (
                set(result) - {"step", "ok", "status", "observation"}
                or result.get("step") != call["step"]
                or type(result.get("ok")) is not bool
                or type(result.get("status")) is not int
                or not 0 <= result["status"] <= 599
            ):
                raise ValueError("Files observation is not a bounded receipt")
            expected = {
                "id": call["path"],
                "kind": call["kind"],
                "properties": call["body"]["properties"],
            }
            if result["ok"]:
                if result.get("observation") != expected or result["status"] not in {200, 201}:
                    raise ValueError("Files observation does not match the approved resource")
            elif "observation" in result or index != len(completed) - 1:
                raise ValueError("An unverified Files operation cannot advance")

    def prepare(self, phase: str, step: str, completed: list[dict]) -> tuple[dict, dict]:
        self._validate_prefix(completed)
        prior = self.previous
        if phase == "intent":
            if (
                len(completed) >= len(self.calls)
                or step != self.calls[len(completed)]["step"]
                or (prior is None and completed)
                or (
                    prior is not None
                    and (
                        prior["phase"] != "observed"
                        or prior["completed"] != completed
                        or not all(x["ok"] for x in completed)
                    )
                )
            ):
                raise ValueError("Files requires an acknowledged prefix before mutation")
        elif phase == "observed":
            if (
                not prior
                or prior["phase"] != "intent"
                or prior["step"] != step
                or not completed
                or completed[-1]["step"] != step
                or completed[:-1] != prior["completed"]
            ):
                raise ValueError("Files observation has no matching intent")
        elif phase == "replacement_intent":
            if (
                not self.complete
                or not prior
                or prior["phase"] != "observed"
                or prior["completed"] != completed
                or step != self.calls[-1]["step"]
            ):
                raise ValueError("Files replacement requires its complete observed resources")
        else:
            raise ValueError("Unknown Files checkpoint phase")
        checkpoint = {
            **self._binding(),
            "phase": phase,
            "step": step,
            "completed": deepcopy(completed),
        }
        return checkpoint, self.inventory_for(completed)

    def inventory_for(self, completed: list[dict]) -> dict:
        """One inventory projection for ordinary writes and qualified recovery."""
        self._validate_prefix(completed)
        return {
            "version": "azure.files.inventory.v1",
            "ownerId": self.plan.ownerId,
            "hushhId": self.plan.hushhId,
            "serviceUid": self.plan.serviceUid,
            "planDigest": self.plan.digest,
            "tenantId": self.plan.tenantId,
            "subscriptionId": self.plan.subscriptionId,
            "resourceGroup": self.plan.resourceGroup,
            "setupNonce": self.plan.setupNonce,
            "plannedOperations": self.plan.operations(),
            "observations": [x["observation"] for x in completed if x["ok"]],
        }

    def acknowledge(self, checkpoint: dict) -> None:
        self.previous = deepcopy(checkpoint)

    @property
    def complete(self) -> bool:
        previous = self.previous or {}
        return (
            previous.get("phase") in {"observed", "replacement_intent"}
            and len(previous.get("completed", [])) == len(self.calls)
            and all(x["ok"] for x in previous["completed"])
        )
