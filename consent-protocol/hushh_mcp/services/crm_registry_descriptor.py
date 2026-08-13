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
from hushh_mcp.services.crm_encrypted_fields_v1 import (
    CrmEncryptedFieldsValidationError,
    validate_crm_encrypted_fields_recipient_key,
)

OPERATIONS = ("schema", "read", "create", "update", "delete")
CRM_ENCRYPTED_FIELDS_CONFORMANCE_VERSION = "crm-encrypted-fields-conformance.v1"


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
    credential_env_names: tuple[str | None, str | None]

    @property
    def crm_id(self) -> str:
        return _text(self.raw.get("crmId"))

    @property
    def operations(self) -> dict[str, dict[str, Any]]:
        return dict(self.raw.get("operations") or {})

    @property
    def capabilities(self) -> tuple[str, ...]:
        return tuple(self.raw.get("capabilities") or ())

    @property
    def encrypted_fields(self) -> dict[str, Any] | None:
        value = self.raw.get("encryptedFields")
        return dict(value) if isinstance(value, dict) else None

    @property
    def required_mcp_tool_names(self) -> tuple[str, ...]:
        """All tool names an activation probe must find before it can enable a CRM.

        An encrypted-fields tool may intentionally be the same registered
        ``read`` or ``update`` tool. It is still listed here so a descriptor
        cannot point the encrypted path at an undeployed MuleSoft capability.
        """
        names = {_text(config.get("toolName")) for config in self.operations.values()}
        encrypted_tools = (self.encrypted_fields or {}).get("tools") or {}
        names.update(_text(encrypted_tools.get(operation)) for operation in ("read", "update"))
        return tuple(sorted(name for name in names if name))


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

    auth_header_style = _text(raw.get("authHeaderStyle") or "bearer").lower()
    gateway_credential_profile = _text(raw.get("gatewayCredentialProfile") or "shared").lower()
    if gateway_credential_profile not in {"shared", "external_crm"}:
        raise CrmRegistryDescriptorError("gatewayCredentialProfile must be shared or external_crm.")
    connection_mode = _text(raw.get("connectionMode") or "managed").lower()
    if connection_mode not in {"managed", "dynamic_registry"}:
        raise CrmRegistryDescriptorError("connectionMode must be managed or dynamic_registry.")
    if connection_mode == "dynamic_registry" and auth_header_style != "bearer":
        raise CrmRegistryDescriptorError("dynamic_registry requires bearer gateway authentication.")
    if gateway_credential_profile == "external_crm" and connection_mode != "dynamic_registry":
        raise CrmRegistryDescriptorError(
            "external_crm gateway credentials require dynamic_registry connection mode."
        )
    credentials = raw.get("credentials")
    client_id_env: str | None = None
    client_secret_env: str | None = None
    if auth_header_style != "bearer" or connection_mode == "dynamic_registry":
        if not isinstance(credentials, dict):
            raise CrmRegistryDescriptorError("credentials is required for header-auth connectors.")
        client_id_env = _safe_env_name(credentials.get("clientIdEnv"), "clientIdEnv")
        client_secret_env = _safe_env_name(credentials.get("clientSecretEnv"), "clientSecretEnv")
    crm_connection = raw.get("crmConnection")
    if connection_mode == "dynamic_registry":
        if not isinstance(crm_connection, dict):
            raise CrmRegistryDescriptorError(
                "crmConnection is required for dynamic_registry connectors."
            )
        _require_url(crm_connection.get("baseUrl"), "crmConnection.baseUrl")
        endpoint = _text(crm_connection.get("mcpEndpoint"))
        if not endpoint or not endpoint.startswith("/"):
            raise CrmRegistryDescriptorError(
                "crmConnection.mcpEndpoint must be an absolute CRM-relative path."
            )
        _require_url(crm_connection.get("tokenUrl"), "crmConnection.tokenUrl")
    if require_credentials and client_id_env and client_secret_env:
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

    operation_object_types = {
        operation: _text(config.get("objectType")) or _text(raw.get("primaryObject"))
        for operation, config in operations.items()
    }

    encrypted_fields = raw.get("encryptedFields")
    if encrypted_fields is not None:
        if not isinstance(encrypted_fields, dict) or encrypted_fields.get("enabled") is not True:
            raise CrmRegistryDescriptorError(
                "encryptedFields.enabled must be true when configured."
            )
        if raw.get("environment") != "sandbox":
            raise CrmRegistryDescriptorError("encryptedFields activation is sandbox-only.")
        if not {"read", "update"}.issubset(capability_set):
            raise CrmRegistryDescriptorError(
                "encryptedFields requires read and update capabilities."
            )
        recipient_key = encrypted_fields.get("recipientKey")
        if not isinstance(recipient_key, dict) or not all(
            _text(recipient_key.get(key)) for key in ("keyId", "publicKey", "publicKeyFingerprint")
        ):
            raise CrmRegistryDescriptorError(
                "encryptedFields.recipientKey requires keyId, publicKey, and publicKeyFingerprint."
            )
        try:
            validate_crm_encrypted_fields_recipient_key(recipient_key)
        except CrmEncryptedFieldsValidationError as error:
            raise CrmRegistryDescriptorError(
                "encryptedFields.recipientKey must contain a 32-byte X25519 public key "
                "and its matching SHA-256 fingerprint."
            ) from error
        tools = encrypted_fields.get("tools")
        if not isinstance(tools, dict) or not all(
            _text(tools.get(key)) for key in ("read", "update")
        ):
            raise CrmRegistryDescriptorError(
                "encryptedFields.tools requires read and update tool names."
            )
        if set(tools) != {"read", "update"}:
            raise CrmRegistryDescriptorError(
                "encryptedFields.tools may contain only read and update tool names."
            )
        partner_conformance = encrypted_fields.get("partnerConformance")
        if not isinstance(partner_conformance, dict) or set(partner_conformance) != {
            "version",
            "evidenceSha256",
            "decryptedFieldAllowlistEnforced",
            "strictToolSchemaValidated",
        }:
            raise CrmRegistryDescriptorError(
                "encryptedFields.partnerConformance must contain the exact reviewed "
                "conformance attestation fields."
            )
        if partner_conformance.get("version") != CRM_ENCRYPTED_FIELDS_CONFORMANCE_VERSION:
            raise CrmRegistryDescriptorError(
                "encryptedFields.partnerConformance.version is unsupported."
            )
        evidence_digest = _text(partner_conformance.get("evidenceSha256"))
        if (
            not evidence_digest.startswith("sha256:")
            or len(evidence_digest) != 71
            or any(character not in "0123456789abcdef" for character in evidence_digest[7:])
        ):
            raise CrmRegistryDescriptorError(
                "encryptedFields.partnerConformance.evidenceSha256 must be a lowercase SHA-256 digest."
            )
        if partner_conformance.get("decryptedFieldAllowlistEnforced") is not True:
            raise CrmRegistryDescriptorError(
                "MuleSoft must attest that decrypted CRM update fields are schema-allowlisted."
            )
        if partner_conformance.get("strictToolSchemaValidated") is not True:
            raise CrmRegistryDescriptorError(
                "MuleSoft strict encrypted-fields tool schemas must be validated before activation."
            )

    if capability_set.intersection({"create", "update", "delete"}):
        if not {"read", "create", "update", "delete"}.issubset(capability_set):
            raise CrmRegistryDescriptorError(
                "Write activation requires read/create/update/delete so the isolated fixture can be verified and cleaned up."
            )
        probe = raw.get("probe") or {}
        lifecycle = probe.get("lifecycle")
        cross_object = (
            len(
                {
                    operation_object_types[operation]
                    for operation in ("create", "read", "update", "delete")
                }
            )
            > 1
        )
        if cross_object and probe.get("mode") != "cross-object-bound-lifecycle.v1":
            raise CrmRegistryDescriptorError(
                "Cross-object CRM operations require probe.mode=cross-object-bound-lifecycle.v1; "
                "a Person Account create id must never be reused for a Contact lifecycle."
            )
        if not cross_object and (
            not isinstance(lifecycle, dict)
            or not all(
                isinstance(lifecycle.get(operation), dict)
                for operation in ("create", "read", "update", "delete")
            )
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
        "credentialSources": [name for name in descriptor.credential_env_names if name],
        "credentialsPresent": all(
            os.getenv(name) for name in descriptor.credential_env_names if name
        ),
        "encryptedFields": bool(descriptor.encrypted_fields),
        "gatewayCredentialProfile": _text(
            descriptor.raw.get("gatewayCredentialProfile") or "shared"
        ).lower(),
        "connectionMode": _text(descriptor.raw.get("connectionMode") or "managed").lower(),
    }
