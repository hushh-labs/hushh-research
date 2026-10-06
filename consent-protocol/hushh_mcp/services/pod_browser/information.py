"""Selected non-secret PKM projections, with distinct processing/disclosure grants."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from dataclasses import field as private_field
from typing import Protocol

from pydantic import Field

from hushh_mcp.consent.export_envelope import ConsentExportEnvelopeSubmissionV2
from hushh_mcp.consent.export_projection import (
    decrypt_scoped_export_package,
    project_domain_data_for_scope,
)
from hushh_mcp.consent.field_sensitivity import field_sensitivity

from .consent import BrowserConsentPort
from .contracts import BrowserBinding, BrowserRefused, StrictContract
from .network import public_origin


class InformationField(StrictContract):
    domain: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    path: str = Field(pattern=r"^[a-z0-9_]+(?:\.[a-z0-9_]+){0,7}$", max_length=256)
    export_revision: int = Field(ge=1)
    source_content_revision: int = Field(ge=1)
    source_manifest_revision: int = Field(ge=1)

    @property
    def scope(self) -> str:
        return f"attr.{self.domain}.{self.path}"


class ConsentedProjectionPort(Protocol):
    """Existing scoped-export owner, not a raw replica reader.

    Verify current owner, recipient, V2 envelope, exact grant/scope/revision,
    expiry/revocation and manifest-admitted field before returning plaintext.
    Values stay in pod memory. Missing grant/source must raise, never fall back
    to conversational memory, public discovery or an unrestricted PKM read.
    """

    async def read(self, binding: BrowserBinding, field: InformationField) -> dict: ...


@dataclass(frozen=True)
class AuthorizedScopedExport:
    binding: BrowserBinding
    field: InformationField
    app_id: str
    grant_id: str
    recipient_fingerprint: str
    source_content_revision: int
    source_manifest_revision: int
    envelope: ConsentExportEnvelopeSubmissionV2
    wrapped_key_bundle: dict = private_field(repr=False)
    iv_b64: str = private_field(repr=False)
    tag_b64: str = private_field(repr=False)
    ciphertext: bytes = private_field(repr=False)
    connector_private_key: object = private_field(repr=False)


class ScopedExportPort(Protocol):
    async def load_current(
        self, binding: BrowserBinding, field: InformationField
    ) -> AuthorizedScopedExport:
        """Existing grant owner verifies current scope/revision, expiry and revocation."""
        ...


class ScopedProjectionReader:
    """Decrypt only an exact current V2 export delivered to this trusted pod."""

    def __init__(self, exports: ScopedExportPort) -> None:
        self._exports = exports

    async def read(self, binding: BrowserBinding, field: InformationField) -> dict:
        package = await self._exports.load_current(binding, field)
        aad = package.envelope.aad
        if (
            package.binding != binding
            or package.field != field
            or aad.app_id != package.app_id
            or aad.grant_id != package.grant_id
            or aad.machine_scope != field.scope
            or aad.revision != field.export_revision
            or package.source_content_revision != field.source_content_revision
            or package.source_manifest_revision != field.source_manifest_revision
            or aad.recipient_key_fingerprint != package.recipient_fingerprint
            or aad.expires_at_ms <= time.time() * 1000
            or len(package.ciphertext) > 65536
        ):
            raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")
        try:
            payload = decrypt_scoped_export_package(
                wrapped_key_bundle=package.wrapped_key_bundle,
                iv_b64=package.iv_b64,
                tag_b64=package.tag_b64,
                ciphertext=package.ciphertext,
                connector_private_key=package.connector_private_key,
                export_envelope=package.envelope.model_dump(),
            )
        except Exception:
            raise BrowserRefused("BROWSER_INFORMATION_EXPORT_INVALID") from None
        if not isinstance(payload, dict):
            raise BrowserRefused("BROWSER_INFORMATION_SELECTION_REFUSED")
        metadata = payload.get("__export_metadata", {})
        if (
            not isinstance(metadata, dict)
            or not isinstance(payload.get(field.domain), dict)
            or metadata.get("source_domain") != field.domain
            or metadata.get("approved_paths") != [field.path]
        ):
            raise BrowserRefused("BROWSER_INFORMATION_SELECTION_REFUSED")
        return dict(payload[field.domain])


def selected_projection(field: InformationField, source: dict) -> dict:
    if field.domain in {"secrets", "runtime_secrets", "wallet", "identity"}:
        raise BrowserRefused("BROWSER_SECRET_INFORMATION_REFUSED")
    value = source
    for segment in field.path.split("."):
        if not isinstance(value, dict) or segment not in value:
            raise BrowserRefused("BROWSER_INFORMATION_UNAVAILABLE")
        value = value[segment]
    # Pilot admits bounded scalar facts only; nested records require their own
    # exact field selection rather than hiding protected children in a parent.
    if (
        type(value) not in {str, int, float, bool}
        or field_sensitivity(field.path, value, domain=field.domain) != "standard"
    ):
        raise BrowserRefused("BROWSER_SECRET_INFORMATION_REFUSED")
    if len(json.dumps(value, allow_nan=False).encode()) > 4096:
        raise BrowserRefused("BROWSER_INFORMATION_TOO_LARGE")
    projection = project_domain_data_for_scope(
        field.domain, field.scope, source, approved_paths=[field.path]
    )
    if not isinstance(projection, dict):
        raise BrowserRefused("BROWSER_INFORMATION_SELECTION_REFUSED")
    return projection


class BrowserInformation:
    def __init__(self, source: ConsentedProjectionPort, consent: BrowserConsentPort) -> None:
        self._source, self._consent = source, consent

    async def _read(self, binding: BrowserBinding, fields: tuple[InformationField, ...]) -> dict:
        if len(fields) > 16 or len(set(fields)) != len(fields):
            raise BrowserRefused("BROWSER_INFORMATION_SELECTION_REFUSED")
        await self._consent.check_binding(binding)
        result = {}
        for field in fields:
            if field.domain in {"secrets", "runtime_secrets", "wallet", "identity"}:
                raise BrowserRefused("BROWSER_SECRET_INFORMATION_REFUSED")
            source = await self._source.read(binding, field)
            result[field.scope] = selected_projection(field, source)
        await self._consent.check_binding(binding)
        return result

    async def for_model(
        self,
        binding: BrowserBinding,
        fields: tuple[InformationField, ...],
        *,
        model: str,
        transport: str,
        allowed_origins: tuple[str, ...],
    ) -> dict:
        if (
            not 1 <= len(allowed_origins) <= 20
            or len(set(allowed_origins)) != len(allowed_origins)
            or any(public_origin(origin) != origin for origin in allowed_origins)
        ):
            raise BrowserRefused("BROWSER_PROCESSING_ORIGINS_INVALID")
        values = await self._read(binding, fields)
        terms = {
            "fields": [field.model_dump() for field in fields],
            "values": values,
            "model": model,
            "transport": transport,
            "origins": [public_origin(origin) for origin in allowed_origins],
            "screen_processing": True,
        }
        await self._consent.require(binding, "model_process", terms)
        # Recheck source revisions after approval and refuse a changed projection.
        if values != await self._read(binding, fields):
            raise BrowserRefused("BROWSER_INFORMATION_CHANGED")
        return values

    async def for_website(
        self,
        binding: BrowserBinding,
        fields: tuple[InformationField, ...],
        *,
        destination: str,
        action_sequence: int,
        control_epoch: int,
        request_commitment: str,
    ) -> dict:
        if not fields:
            raise BrowserRefused("BROWSER_INFORMATION_SELECTION_REFUSED")
        values = await self._read(binding, fields)
        public_origin(destination)
        if (
            type(action_sequence) is not int
            or type(control_epoch) is not int
            or action_sequence < 1
            or control_epoch < 1
            or not re.fullmatch(r"[a-f0-9]{64}", request_commitment)
        ):
            raise BrowserRefused("BROWSER_DISCLOSURE_TERMS_INVALID")
        await self._consent.require(
            binding,
            "disclose",
            {
                "fields": [field.model_dump() for field in fields],
                "values": values,
                "destination": destination,
                "sequence": action_sequence,
                "epoch": control_epoch,
                "request_commitment": request_commitment,
            },
        )
        if values != await self._read(binding, fields):
            raise BrowserRefused("BROWSER_INFORMATION_CHANGED")
        return values


@dataclass(frozen=True)
class BrowserModelProcessing:
    """Provider-specific task terms, checked independently by the agent factory."""

    information: BrowserInformation
    binding: BrowserBinding
    fields: tuple[InformationField, ...]
    model_name: str
    transport: str
    allowed_origins: tuple[str, ...]

    async def require(self) -> dict:
        return await self.information.for_model(
            self.binding,
            self.fields,
            model=self.model_name,
            transport=self.transport,
            allowed_origins=self.allowed_origins,
        )
