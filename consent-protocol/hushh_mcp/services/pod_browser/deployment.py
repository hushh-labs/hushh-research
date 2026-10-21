"""Bind reviewed image qualification to recovered identity and owner policy.

The deployment authority verifies probe receipts before installing qualification.
Qualification never enables Browser or changes destinations. Owner policy is a
separate, explicitly approved configuration; neither contains a future revision
name or a key that can only be recovered at startup.
"""

from __future__ import annotations

import json
import os
from typing import Literal

from pydantic import Field

from hushh_mcp.services.pod_azure_vm_identity import active_vm_installation
from hushh_mcp.services.pod_platform import workload_platform
from hushh_mcp.services.pod_release import validate_qualification
from hushh_mcp.services.pod_session_authority import active_session_authority
from hushh_mcp.services.pod_upgrade_admission import pod_incarnation

from .contracts import BrowserReadiness, BrowserRefused, StrictContract
from .execution_authority import PublicResearchPolicy


class BrowserOwnerPolicy(StrictContract):
    version: Literal[1]
    pod_id: str = Field(min_length=1, max_length=256)
    pod_key_id: str = Field(min_length=1, max_length=256)
    public_policy: PublicResearchPolicy


def installed_browser_host() -> tuple[str, str]:
    """Use verified VM identity or native Cloud Run, never Azure cloud alone."""
    vm = active_vm_installation()
    if vm is not None:
        return "azure_vm", vm.image_digest
    if workload_platform() == "gcp" and os.getenv("K_SERVICE") and os.getenv("K_REVISION"):
        # Rendered with the exact verified owner-registry image, not a mutable tag.
        return "gcp_cloud_run", os.getenv("HUSSH_POD_INSTALLED_IMAGE_DIGEST", "")
    raise BrowserRefused("BROWSER_HOST_UNQUALIFIED")


class BrowserDeployment(StrictContract):
    """Process-local binding, constructed only after authenticated recovery."""

    version: Literal[1]
    environment: Literal["development"]
    pod_id: str = Field(min_length=1, max_length=256)
    pod_key_id: str = Field(min_length=1, max_length=256)
    incarnation: str = Field(min_length=1, max_length=256)
    image_tag: str = Field(min_length=1, max_length=128)
    host_kind: Literal["gcp_cloud_run", "azure_vm"]
    evidence_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    readiness: BrowserReadiness
    public_policy: PublicResearchPolicy

    def require_current(self, authority) -> None:
        self.readiness.require_ready()
        if (
            authority is not active_session_authority()
            or authority.environment not in {"dev", "development"}
            or self.pod_id != authority.hushh_id
            or self.pod_key_id != authority.pod_key_id
            or self.incarnation != pod_incarnation()
            or self.readiness.cloud != workload_platform()
            or self.image_tag != os.environ.get("HUSSH_POD_IMAGE_TAG")
            or installed_browser_host() != (self.host_kind, self.readiness.component_digest)
        ):
            raise BrowserRefused("BROWSER_QUALIFICATION_CHANGED")


def recovered_browser_deployment(authority) -> BrowserDeployment:
    raw = os.getenv("HUSSH_BROWSER_QUALIFICATION_JSON", "")
    policy = os.getenv("HUSSH_BROWSER_POLICY_JSON", "")
    if not raw or len(raw.encode()) > 8192:
        raise BrowserRefused("BROWSER_QUALIFICATION_REQUIRED")
    if not policy or len(policy.encode()) > 49152:
        raise BrowserRefused("BROWSER_OWNER_POLICY_REQUIRED")
    try:
        value = json.loads(raw)
        host, digest = installed_browser_host()
        if not isinstance(value, dict) or value.get("host_kind") != host:
            raise BrowserRefused("BROWSER_HOST_UNQUALIFIED")
        qualified = validate_qualification(
            value, image_digest=digest, source_revision=value.get("source_revision", "")
        )
        approved = BrowserOwnerPolicy.model_validate_json(policy)
        if approved.public_policy.digest != qualified["public_policy_sha256"]:
            raise BrowserRefused("BROWSER_OWNER_POLICY_UNQUALIFIED")
        deployment = BrowserDeployment(
            version=1,
            environment="development",
            pod_id=approved.pod_id,
            pod_key_id=approved.pod_key_id,
            incarnation=pod_incarnation(),
            image_tag=qualified["image_tag"],
            host_kind=host,
            evidence_sha256=qualified["evidence_sha256"],
            readiness=BrowserReadiness.model_validate(qualified["readiness"]),
            public_policy=approved.public_policy,
        )
        deployment.require_current(authority)
        return deployment
    except (ValueError, TypeError, KeyError):
        raise BrowserRefused("BROWSER_QUALIFICATION_INVALID") from None
