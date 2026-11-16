"""Copy retained host identity into lifecycle specs without provider inference."""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from hushh_mcp.services.azure_vm_host_binding import AzureVmHostBinding


class PodAdoptionExpectations(TypedDict):
    expected_service_uid: str | None
    expected_runtime_principal: str | None
    expected_image_digest: str | None
    expected_setup_nonce: str | None
    azure_vm_host: AzureVmHostBinding | None


class PodAdoptionRefused(RuntimeError):
    """Retained deployment identity does not authorize adopting an observed host."""


def has_hosted_evidence(row: object) -> bool:
    """Classify managed custody before selecting any owner-cloud adapter."""
    if not isinstance(row, dict):
        return False
    metadata = row.get("backend_metadata") or {}
    if not isinstance(metadata, dict):
        return False
    attempt = metadata.get("provisionAttempt")
    return metadata.get("tenancy") == "hussh-hosted" or (
        isinstance(attempt, dict) and "hostedAdmission" in attempt
    )


def adoption_expectations(metadata: object) -> PodAdoptionExpectations:
    """Malformed or unknown explicit host bindings refuse rather than selecting ACA."""
    recorded = metadata if isinstance(metadata, dict) else {}
    vm = None
    if "hostKind" in recorded or "vmHost" in recorded:
        from hushh_mcp.services.azure_vm_host_binding import recorded_vm_host

        vm = recorded_vm_host(recorded)
    return {
        "expected_service_uid": str(recorded.get("serviceUid") or "") or None,
        "expected_runtime_principal": str(
            recorded.get("runtime_principal_id") or recorded.get("runtime_service_account") or ""
        )
        or None,
        "expected_image_digest": str(recorded.get("image_digest") or recorded.get("image") or "")
        or None,
        "expected_setup_nonce": str(recorded.get("setupNonce") or "") or None,
        "azure_vm_host": vm,
    }
