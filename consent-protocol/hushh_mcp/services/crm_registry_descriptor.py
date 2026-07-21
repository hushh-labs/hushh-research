"""Validation and redacted fingerprinting for local crm-registry.v1 descriptors."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from hushh_mcp.services.connected_systems_service import (
    _valid_operation_response_contract,
)

OPERATIONS = ("schema", "read", "create", "update", "delete")


class CrmRegistryDescriptorError(ValueError):
    pass


def _text(value: Any) -> str:
    return str(value or "").strip()


def _require_url(value: Any, label: str) -> str:
    candidate = _text(value)
    parsed = urlparse(candidate)
    if parsed.scheme not in {"https", "registry"} or not parsed.netloc:
        raise CrmRegistryDescriptorError(f"{label} must be an HTTPS or registry URL.")
    return candidate


def _safe_env_name(value: Any, label: str) -> str:
    name = _text(value)
    if not name or not name.replace("_", "").isalnum() or name.upper() != name:
        raise CrmRegistryDescriptorError(f"{label} must name an uppercase environment variable.")
    return name


@dataclass(frozen=True)
class ValidatedCrmRegistryDescriptor:
    raw: dict[str, Any]
    fingerprint: str
    credential_env_names: tuple[str, str]

    @property
    def crm_id(self) -> str:
        return _text(self.raw.get("crmId"))

    @property
    def operations(self) -> dict[str, dict[str, Any]]:
        return dict(self.raw.get("operations") or {})

    @property
    def capabilities(self) -> tuple[str, ...]:
        return tuple(self.raw.get("capabilities") or ())


def load_and_validate_descriptor(
    path: str | Path, *, require_credentials: bool = True
) -> ValidatedCrmRegistryDescriptor:
    descriptor_path = Path(path).expanduser().resolve()
    try:
        raw = json.loads(descriptor_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CrmRegistryDescriptorError("Descriptor must be a readable JSON object.") from error
    if not isinstance(raw, dict) or raw.get("version") != "crm-registry.v1":
        raise CrmRegistryDescriptorError("Descriptor version must be crm-registry.v1.")

    for key in ("crmId", "displayName", "crmType", "environment", "primaryObject"):
        if not _text(raw.get(key)):
            raise CrmRegistryDescriptorError(f"{key} is required.")
    if raw.get("environment") not in {"sandbox", "production"}:
        raise CrmRegistryDescriptorError("environment must be sandbox or production.")
    _require_url(raw.get("baseUrl"), "baseUrl")
    _require_url(raw.get("mcpEndpoint"), "mcpEndpoint")
    if _text(raw.get("authHeaderStyle") or "bearer").lower() not in {
        "bearer",
        "client_id_secret_headers",
    }:
        raise CrmRegistryDescriptorError(
            "authHeaderStyle must be bearer or client_id_secret_headers."
        )

    credentials = raw.get("credentials")
    if not isinstance(credentials, dict):
        raise CrmRegistryDescriptorError("credentials is required.")
    client_id_env = _safe_env_name(credentials.get("clientIdEnv"), "clientIdEnv")
    client_secret_env = _safe_env_name(credentials.get("clientSecretEnv"), "clientSecretEnv")
    if require_credentials:
        missing = [
            name for name in (client_id_env, client_secret_env) if not _text(os.getenv(name))
        ]
        if missing:
            raise CrmRegistryDescriptorError(
                f"Required credential environment variables are missing: {', '.join(missing)}."
            )

    capabilities = raw.get("capabilities")
    if not isinstance(capabilities, list) or not capabilities:
        raise CrmRegistryDescriptorError("capabilities must be a non-empty operation list.")
    capability_set = {_text(value) for value in capabilities}
    if "schema" not in capability_set or not capability_set.issubset(OPERATIONS):
        raise CrmRegistryDescriptorError(
            "capabilities must include schema and known operations only."
        )

    operations = raw.get("operations")
    if not isinstance(operations, dict) or set(operations) != capability_set:
        raise CrmRegistryDescriptorError(
            "operations must contain exactly the declared capabilities; disabled operations are omitted."
        )
    for operation, config in operations.items():
        if not isinstance(config, dict) or not _text(config.get("toolName")):
            raise CrmRegistryDescriptorError(f"{operation}.toolName is required.")
        _require_url(
            config.get("mcpEndpoint") or raw.get("mcpEndpoint"), f"{operation}.mcpEndpoint"
        )
        contract = config.get("responseContract")
        if not isinstance(contract, dict) or not _valid_operation_response_contract(
            operation, contract
        ):
            raise CrmRegistryDescriptorError(
                f"{operation}.responseContract is not a supported fixed-path contract."
            )

    if capability_set.intersection({"create", "update", "delete"}):
        if not {"read", "create", "update", "delete"}.issubset(capability_set):
            raise CrmRegistryDescriptorError(
                "Write activation requires read/create/update/delete so the isolated fixture can be verified and cleaned up."
            )
        lifecycle = (raw.get("probe") or {}).get("lifecycle")
        if not isinstance(lifecycle, dict) or not all(
            isinstance(lifecycle.get(operation), dict)
            for operation in ("create", "read", "update", "delete")
        ):
            raise CrmRegistryDescriptorError(
                "CRUD activation requires synthetic probe.lifecycle create/read/update/delete arguments."
            )
    elif "read" in capability_set and not isinstance((raw.get("probe") or {}).get("read"), dict):
        raise CrmRegistryDescriptorError("Read activation requires synthetic probe.read arguments.")

    canonical = json.dumps(raw, sort_keys=True, separators=(",", ":"))
    return ValidatedCrmRegistryDescriptor(
        raw=raw,
        fingerprint=hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        credential_env_names=(client_id_env, client_secret_env),
    )


def redacted_summary(descriptor: ValidatedCrmRegistryDescriptor) -> dict[str, Any]:
    return {
        "version": "crm-registry.v1",
        "crmId": descriptor.crm_id,
        "configurationFingerprint": descriptor.fingerprint,
        "capabilities": list(descriptor.capabilities),
        "credentialSources": list(descriptor.credential_env_names),
        "credentialsPresent": all(os.getenv(name) for name in descriptor.credential_env_names),
    }
