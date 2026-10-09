"""Four approved additions under fresh owner Azure authority, never hub grants."""

from __future__ import annotations

from collections.abc import Callable

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.compute_backend import PodSpec

from .azure_capability import AzureFilesCapabilityPlan
from .azure_checkpoint import qualify_readback
from .capability_update import FilesCapabilityChanged


class AzureFilesBootstrap:
    def __init__(self, plan: AzureFilesCapabilityPlan, arm: ArmClient):
        self.plan, self.arm = plan, arm

    def _read(self, path: str, api: str) -> dict:
        value = self.arm.get(path, api_version=API_VERSIONS[api], op="files_custody")
        if str(value.get("id", "")).lower() != path.lower():
            raise FilesCapabilityChanged("Files custody resource changed")
        return value

    def preflight(self) -> None:
        """Read existing owner custody and any preexisting additions before handoff."""
        try:
            self._preflight()
        except (ArmError, OSError):
            # All calls here are reads. Refuse before the handoff rather than
            # retaining an uncertain-write lease for work never attempted.
            raise FilesCapabilityChanged(
                "Files custody could not be verified; authorize and retry"
            ) from None

    def _preflight(self) -> None:
        plan, scopes = self.plan, self.plan.scopes
        identity = self._read(scopes.identity, "managed_identity").get("properties") or {}
        if (identity.get("principalId"), identity.get("clientId")) != (
            plan.principalId,
            plan.clientId,
        ):
            raise FilesCapabilityChanged("Files owner identity changed")
        key = self._read(scopes.key, "key_vault").get("properties") or {}
        if key.get("keyUriWithVersion") != plan.keyUri:
            raise FilesCapabilityChanged("Files recovery key changed")
        account = self._read(plan.storageId, "storage").get("properties") or {}
        container = self._read(scopes.container, "storage").get("properties") or {}
        service = self._read(scopes.blob_service, "storage").get("properties") or {}
        if (
            account.get("allowBlobPublicAccess") is not False
            or account.get("allowSharedKeyAccess") is not False
            or account.get("supportsHttpsTrafficOnly") is not True
            or account.get("minimumTlsVersion") not in {"TLS1_2", "TLS1_3"}
            or account.get("encryption", {}).get("services", {}).get("blob", {}).get("enabled")
            is not True
            or container.get("publicAccess") != "None"
            or container.get("hasImmutabilityPolicy")
            or container.get("hasLegalHold")
            or (service.get("deleteRetentionPolicy") or {}).get("enabled") is not False
            or (service.get("containerDeleteRetentionPolicy") or {}).get("enabled") is not False
            or service.get("isVersioningEnabled") is not False
        ):
            raise FilesCapabilityChanged(
                "Files requires verified private storage and deletion settings"
            )
        for call in plan.operations():
            existing = self.arm.get_or_none(
                call["path"], api_version=API_VERSIONS[call["api"]], op="files_preflight"
            )
            if existing is not None:
                try:
                    qualify_readback(call, existing)
                except ValueError:
                    raise FilesCapabilityChanged(
                        "Existing Files resource conflicts with this approval"
                    ) from None

    def apply(
        self,
        checkpoint: Callable[[str, str, list[dict]], None],
        *,
        completed_steps: list[dict] | None = None,
    ) -> None:
        completed: list[dict] = list(completed_steps or [])
        calls = self.plan.operations()
        if completed and len(completed) not in {2, len(calls)}:
            raise ValueError("Files continuation requires its qualified prefix")
        for call, receipt in zip(calls, completed, strict=False):
            observed = qualify_readback(
                call,
                self.arm.get(
                    call["path"], api_version=API_VERSIONS[call["api"]], op="files_prefix_readback"
                ),
            )
            if receipt != {
                "step": call["step"],
                "ok": True,
                "status": 200,
                "observation": observed,
            }:
                raise ValueError("Files continuation prefix changed")
        for call in calls[len(completed) :]:
            step, api = call["step"], API_VERSIONS[call["api"]]
            checkpoint("intent", step, completed)
            try:
                existing = self.arm.get_or_none(
                    call["path"], api_version=api, op="files_activation"
                )
                if existing is None:
                    response = self.arm.request(
                        "PUT",
                        call["path"],
                        api_version=api,
                        body=call["body"],
                        op="files_activation",
                    )
                    if self.arm.needs_poll(response):
                        self.arm.wait(response, "files_activation")
                    existing = self.arm.get(
                        call["path"], api_version=api, op="files_activation_readback"
                    )
                observation = qualify_readback(call, existing)
            except (ArmError, ValueError) as exc:
                # A refusal is not proof of absence. Preserve the attempted step
                # and hold the lease for read-only reconciliation.
                status = exc.status if isinstance(exc, ArmError) else 0
                checkpoint(
                    "observed", step, [*completed, {"step": step, "ok": False, "status": status}]
                )
                raise
            completed.append({"step": step, "ok": True, "status": 200, "observation": observation})
            checkpoint("observed", step, completed)


def approved_bootstrap(
    spec: PodSpec, app: dict, arm: ArmClient, app_id: str
) -> AzureFilesBootstrap | None:
    """Validate the exact plan and custody before acquiring a pod handoff."""
    if spec.files_upgrade_plan is None:
        return None

    plan = AzureFilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
    if (
        not spec.on_files_upgrade_checkpoint
        or not spec.upgrade_operation_id
        or not spec.upgrade_attempt_id
        or plan.hushhId != spec.hushh_id
        or plan.serviceUid != str(spec.expected_service_uid or "").strip()
        or plan.service.lower() != app_id.lower()
        or plan.targetImage != spec.upgrade_target_image
    ):
        raise FilesCapabilityChanged("Files requires exact owner approval and durable checkpoints")
    try:
        plan.require_observation(app)
    except ValueError:
        raise FilesCapabilityChanged("Files pod configuration changed before activation") from None
    files = AzureFilesBootstrap(plan, arm)
    files.preflight()
    return files
