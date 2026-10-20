"""Verified local VM identity for the disabled Azure whole-pod qualification.

The host's root-owned installation manifest supplies expected identity, image
and generation. Fixed-address IMDS confirms the VM resource and provider UUID;
it does not attest a container image or qualify owner availability. The lifecycle
controller must independently read back those facts before publishing a host.
"""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path
from typing import Literal
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

HOST_DIRECTORY = Path("/run/hussh-host")
HOST_MANIFEST = "pod.json"
IMDS_COMPUTE = "http://169.254.169.254/metadata/instance/compute"
IMDS_IDENTITY_ENDPOINT = "http://169.254.169.254/metadata/identity/oauth2/token"
_GUID = r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"
_RESOURCE = re.compile(
    rf"/subscriptions/({_GUID})/resourceGroups/([A-Za-z0-9_.()-]{{1,90}})"
    r"/providers/Microsoft.Compute/virtualMachines/([A-Za-z0-9_-]{1,64})",
    re.IGNORECASE,
)
_active: AzureVmInstallation | None = None


class AzureVmIdentityRefused(RuntimeError):
    """Sanitized refusal before credentials or owner state are opened."""


class AzureVmInstallation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    version: Literal[1]
    resource_id: str = Field(max_length=512)
    vm_id: str
    client_id: str
    hushh_id: str = Field(min_length=1, max_length=256)
    image_digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    generation: str = Field(pattern=r"^vm_[a-f0-9]{32}$")

    @field_validator("vm_id", "client_id")
    @classmethod
    def guid(cls, value: str) -> str:
        if not re.fullmatch(_GUID, value):
            raise ValueError("Invalid VM identity")
        return str(UUID(value))

    @field_validator("resource_id")
    @classmethod
    def resource(cls, value: str) -> str:
        if not _RESOURCE.fullmatch(value):
            raise ValueError("Invalid VM resource")
        return value


def _require_environment(installation: AzureVmInstallation) -> None:
    if any(
        os.getenv(name)
        for name in (
            "K_SERVICE",
            "K_REVISION",
            "CONTAINER_APP_NAME",
            "CONTAINER_APP_REVISION",
            "IDENTITY_ENDPOINT",
            "IDENTITY_HEADER",
        )
    ):
        raise AzureVmIdentityRefused("conflicting workload platform")
    if os.getenv("HUSSH_ID") != installation.hushh_id:
        raise AzureVmIdentityRefused("VM owner installation changed")
    for name, expected in (
        ("AZURE_CLIENT_ID", installation.client_id),
        ("HUSSH_POD_INCARNATION", installation.generation),
    ):
        value = os.getenv(name)
        if value and value != expected:
            raise AzureVmIdentityRefused("VM installation identity changed")


def active_vm_installation() -> AzureVmInstallation | None:
    if _active is not None:
        _require_environment(_active)
    return _active


def _require_root_owned(fd: int, *, directory: bool) -> None:
    info = os.fstat(fd)
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if info.st_uid != 0 or info.st_mode & 0o022 or not expected_type(info.st_mode):
        raise AzureVmIdentityRefused("VM installation is not root protected")


def _read_installation() -> AzureVmInstallation | None:
    try:
        directory = os.open(HOST_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        _require_root_owned(directory, directory=True)
        fd = os.open(HOST_MANIFEST, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(fd, "rb") as source:
            _require_root_owned(source.fileno(), directory=False)
            raw = source.read(8193)
        if len(raw) > 8192:
            raise AzureVmIdentityRefused("VM installation exceeds its bound")
        return AzureVmInstallation.model_validate_json(raw)
    finally:
        os.close(directory)


def imds_json(endpoint: str, params: dict[str, str]) -> dict:
    """Fixed IMDS only; no proxy, redirects, unbounded reads or retained client."""
    if endpoint not in {IMDS_COMPUTE, IMDS_IDENTITY_ENDPOINT}:
        raise AzureVmIdentityRefused("unsupported VM metadata endpoint")
    try:
        with httpx.Client(
            trust_env=False, follow_redirects=False, timeout=httpx.Timeout(5.0, connect=2.0)
        ) as client:
            with client.stream(
                "GET", endpoint, params=params, headers={"Metadata": "true"}
            ) as response:
                if response.status_code != 200:
                    raise AzureVmIdentityRefused("VM metadata unavailable")
                value = bytearray()
                for chunk in response.iter_bytes(8192):
                    value.extend(chunk)
                    if len(value) > 65536:
                        raise AzureVmIdentityRefused("VM metadata exceeds its bound")
        decoded = json.loads(value)
        if not isinstance(decoded, dict):
            raise AzureVmIdentityRefused("VM metadata invalid")
        return decoded
    except AzureVmIdentityRefused:
        raise
    except Exception:
        raise AzureVmIdentityRefused("VM metadata unavailable") from None


def initialize_vm_installation() -> None:
    """Worker startup, before recovery; an absent manifest keeps existing hosts."""
    global _active
    try:
        installation = _read_installation()
        if installation is None:
            if _active is not None:
                raise AzureVmIdentityRefused("VM installation disappeared")
            return
        _require_environment(installation)
        if _active is not None:
            if installation != _active:
                raise AzureVmIdentityRefused("VM installation changed")
            return
        compute = imds_json(IMDS_COMPUTE, {"api-version": "2025-04-07"})
        match = _RESOURCE.fullmatch(installation.resource_id)
        if match is None:
            raise AzureVmIdentityRefused("VM resource invalid")
        if (
            str(compute.get("resourceId", "")).lower() != installation.resource_id.lower()
            or str(compute.get("vmId", "")).lower() != installation.vm_id
            or str(compute.get("subscriptionId", "")).lower() != match[1].lower()
            or str(compute.get("resourceGroupName", "")).lower() != match[2].lower()
            or compute.get("osType") != "Linux"
            # IMDS uses both AzurePublicCloud and AZUREPUBLICCLOUD. Normalize
            # casing only; another cloud or a non-string value stays refused.
            or not isinstance(compute.get("azEnvironment"), str)
            or compute["azEnvironment"].casefold() != "azurepubliccloud"
        ):
            raise AzureVmIdentityRefused("VM metadata does not match installation")
        _active = installation
    except AzureVmIdentityRefused:
        raise
    except Exception:
        raise AzureVmIdentityRefused("VM installation identity unavailable") from None
