"""Strict website credential envelopes and revision-fenced derivative custody.

PKM remains authoritative. The pod log retains only exact recipient-encrypted
record projections and monotonic fences; every use must re-read current grant,
source revisions, owner/pod identity and Session-only policy. It holds no MVK.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any, Literal

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.services import pod_sealed_envelope as sealed
from hushh_mcp.services.pod_session_authority import canonical_json
from hushh_mcp.services.public_endpoint_policy import validate_mcp_endpoint

_ID = r"^cred_[a-f0-9]{32}$"
RECORD_KIND = "website_credential_projection_v1"
FENCE_KIND = "website_credential_fence_v1"
POLICIES = Literal["autonomous", "confirm_before_fill", "vault_only"]


class CredentialRefused(ValueError):
    def __init__(self, code: str = "CREDENTIAL_REFUSED") -> None:
        self.code = code
        super().__init__(code)


class StrictCredential(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)


class CredentialSummary(StrictCredential):
    id: str = Field(pattern=_ID)
    label: str = Field(min_length=1, max_length=128, repr=False)
    boundOrigins: list[str] = Field(min_length=1, max_length=16, repr=False)
    usernameHint: str = Field(max_length=128, repr=False)
    autonomyPolicy: POLICIES
    revision: int = Field(ge=1)
    generation: int = Field(ge=1)
    policyGeneration: int = Field(ge=1)
    custodyGeneration: int = Field(ge=1)


class CredentialAad(StrictCredential):
    purpose: Literal["website_credential_payload"]
    ownerId: str = Field(min_length=1, max_length=256)
    credentialId: str = Field(pattern=_ID)
    revision: int = Field(ge=1)
    generation: int = Field(ge=1)
    policyGeneration: int = Field(ge=1)
    custodyGeneration: int = Field(ge=1)
    autonomyPolicy: POLICIES
    boundOrigins: list[str] = Field(min_length=1, max_length=16, repr=False)

    @model_validator(mode="after")
    def exact_origins(self):
        from urllib.parse import urlsplit

        if self.boundOrigins != sorted(set(self.boundOrigins)):
            raise ValueError("credential_origin_invalid")
        for value in self.boundOrigins:
            parsed = urlsplit(value)
            validate_mcp_endpoint(value)
            if value != f"https://{parsed.hostname}" or parsed.port is not None:
                raise ValueError("credential_origin_invalid")
        return self


class CredentialCiphertext(StrictCredential):
    iv: str = Field(max_length=16, repr=False)
    ct: str = Field(min_length=22, max_length=32768, repr=False)

    @model_validator(mode="after")
    def bounded_ciphertext(self):
        sealed.b64url_decode(self.iv, length=12)
        if not 16 <= len(sealed.b64url_decode(self.ct)) <= 24576:
            raise ValueError("credential_ciphertext_invalid")
        return self


class CredentialPodAad(CredentialAad):
    hushhId: str = Field(min_length=1, max_length=256)
    podKeyId: str = Field(min_length=1, max_length=128)


class CredentialPodWrap(CredentialCiphertext):
    v: Literal[1]
    alg: Literal["X25519-HKDF-SHA256-AES256GCM"]
    epk: str = Field(max_length=43, repr=False)
    aad: CredentialPodAad = Field(repr=False)

    @model_validator(mode="after")
    def ephemeral_key(self):
        sealed.b64url_decode(self.epk, length=32)
        return self


class CredentialRecord(StrictCredential):
    schemaVersion: Literal[1]
    aad: CredentialAad = Field(repr=False)
    payload: CredentialCiphertext = Field(repr=False)
    ownerWrap: CredentialCiphertext = Field(repr=False)
    podWrap: CredentialPodWrap | None = Field(repr=False)

    @model_validator(mode="after")
    def isolated_key(self):
        if (self.aad.autonomyPolicy == "vault_only") != (self.podWrap is None):
            raise ValueError("credential_custody_policy_mismatch")
        if (
            self.podWrap
            and self.podWrap.aad.model_dump(exclude={"hushhId", "podKeyId"})
            != self.aad.model_dump()
        ):
            raise ValueError("credential_key_binding_mismatch")
        if len(sealed.b64url_decode(self.ownerWrap.ct)) != 48:
            raise ValueError("credential_owner_wrap_invalid")
        return self


class WebsiteCredentialProjection(StrictCredential):
    selection: Any = Field(
        repr=False
    )  # Validated below without importing Browser at module import.
    record: CredentialRecord = Field(repr=False)

    @model_validator(mode="after")
    def exact_selection(self):
        from hushh_mcp.services.pod_browser.information_export import BrowserExportSelection

        selected = BrowserExportSelection.model_validate(self.selection)
        object.__setattr__(self, "selection", selected)
        if (
            selected.owner_id != self.record.aad.ownerId
            or selected.field.scope != f"attr.credentials.secrets.{self.record.aad.credentialId}"
            or not selected.field.grant_ref
        ):
            raise ValueError("credential_scope_mismatch")
        wrap = self.record.podWrap
        if wrap is None or (wrap.aad.hushhId, wrap.aad.podKeyId) != (
            selected.pod_id,
            selected.pod_key_id,
        ):
            raise ValueError("credential_recipient_mismatch")
        return self


def _key_purpose() -> sealed.SealPurpose:
    return sealed.SealPurpose(
        name="website_credential_payload",
        hkdf_info=b"hussh/website-credential-key/v1",
        aad_keys=frozenset(CredentialPodAad.model_fields),
        max_ciphertext_bytes=1024,
    )


def open_credential_record(
    record: CredentialRecord,
    private_key: X25519PrivateKey,
    *,
    owner_id: str,
    pod_id: str,
    pod_key_id: str,
) -> dict[str, str]:
    wrap = record.podWrap
    if (
        wrap is None
        or record.aad.ownerId != owner_id
        or (wrap.aad.hushhId, wrap.aad.podKeyId) != (pod_id, pod_key_id)
    ):
        raise CredentialRefused("CREDENTIAL_RECIPIENT_REFUSED")
    try:
        body, _ = sealed.open_envelope(
            wrap.model_dump(), purpose=_key_purpose(), pod_private_key=private_key
        )
        key_body = json.loads(body)
        if not isinstance(key_body, dict) or set(key_body) != {"dataKey"}:
            raise ValueError()
        key = bytearray(sealed.b64url_decode(key_body["dataKey"], length=32))
        try:
            plaintext = bytearray(
                AESGCM(bytes(key)).decrypt(
                    sealed.b64url_decode(record.payload.iv),
                    sealed.b64url_decode(record.payload.ct),
                    canonical_json(record.aad.model_dump()).encode(),
                )
            )
        finally:
            key[:] = b"\0" * len(key)
        try:
            result = json.loads(plaintext)
            if (
                not isinstance(result, dict)
                or set(result) - {"username", "password", "totpSecret", "notes"}
                or not all(
                    isinstance(result.get(k), str) and 0 < len(result[k]) <= 4096
                    for k in ("username", "password")
                )
            ):
                raise ValueError()
            if "totpSecret" in result:
                import re

                if not isinstance(result["totpSecret"], str) or not re.fullmatch(
                    r"[A-Z2-7]{16,128}", result["totpSecret"]
                ):
                    raise ValueError()
            return result
        finally:
            plaintext[:] = b"\0" * len(plaintext)
    except Exception:
        raise CredentialRefused("CREDENTIAL_DECRYPT_REFUSED") from None


class CredentialProjectionStore:
    """Existing encrypted owner commit log, never an independent PKM authority."""

    def __init__(
        self,
        log,
        *,
        owner_id: str,
        pod_id: str,
        pod_key_id: str,
        check: Callable[
            [WebsiteCredentialProjection], Awaitable[WebsiteCredentialProjection | None]
        ],
    ) -> None:
        self.load_current = None
        self.log, self.owner_id, self.pod_id, self.pod_key_id, self.check = (
            log,
            owner_id,
            pod_id,
            pod_key_id,
            check,
        )

    async def _snapshot(self):
        if self.log is None:
            raise CredentialRefused("CREDENTIAL_CUSTODY_UNAVAILABLE")
        records = await self.log.replay()
        current, floors = {}, {}
        for event in records:
            if event.get("kind") not in {RECORD_KIND, FENCE_KIND}:
                continue
            payload = event.get("payload", {})
            if payload.get("owner_id") != self.owner_id or payload.get("pod_id") != self.pod_id:
                continue
            identifier = payload.get("credential_id")
            generation = payload.get("generation")
            if (
                not isinstance(identifier, str)
                or type(generation) is not int
                or generation < floors.get(identifier, 0)
            ):
                continue
            projection = None
            if event["kind"] == RECORD_KIND:
                try:
                    projection = WebsiteCredentialProjection.model_validate(payload["projection"])
                    if (
                        projection.record.aad.generation != generation
                        or projection.record.aad.credentialId != identifier
                    ):
                        projection = None
                except Exception:
                    pass
                if generation == floors.get(identifier, 0):
                    old = current.get(identifier)
                    if (
                        projection is not None
                        and old is not None
                        and self._is_refresh(old, projection)
                    ):
                        current[identifier] = projection
                    continue
            floors[identifier] = generation
            current.pop(identifier, None)
            if projection is not None:
                current[identifier] = projection
        return current, floors, int(records[-1]["seq"]) if records else 0

    @staticmethod
    def _is_refresh(old, new) -> bool:
        return (
            old.record == new.record
            and old.selection.field.grant_ref == new.selection.field.grant_ref
            and new.selection.field.export_revision > old.selection.field.export_revision
        )

    async def generation_floor(self, credential_id: str) -> int:
        import re

        if not re.fullmatch(_ID, credential_id):
            raise CredentialRefused("CREDENTIAL_ID_INVALID")
        _, floors, _ = await self._snapshot()
        return floors.get(credential_id, 0)

    async def publish(self, projection: WebsiteCredentialProjection) -> None:
        from hushh_mcp.services.pod_commit_log import PodLogConflict

        selection = projection.selection
        if (selection.owner_id, selection.pod_id, selection.pod_key_id) != (
            self.owner_id,
            self.pod_id,
            self.pod_key_id,
        ):
            raise CredentialRefused("CREDENTIAL_RECIPIENT_REFUSED")
        for _ in range(3):
            updated = await self.check(projection)
            if updated is not None:
                if (
                    not isinstance(updated, WebsiteCredentialProjection)
                    or updated.record != projection.record
                ):
                    raise CredentialRefused("CREDENTIAL_REVISION_STALE")
                projection = updated
            current, floors, seq = await self._snapshot()
            aad = projection.record.aad
            old = current.get(aad.credentialId)
            if old == projection:
                return
            refresh = old is not None and self._is_refresh(old, projection)
            if aad.generation <= floors.get(aad.credentialId, 0) and not refresh:
                raise CredentialRefused("CREDENTIAL_REVISION_STALE")
            try:
                await self.log.append(
                    RECORD_KIND,
                    {
                        "owner_id": self.owner_id,
                        "pod_id": self.pod_id,
                        "credential_id": aad.credentialId,
                        "generation": aad.generation,
                        "projection": projection.model_dump(mode="json"),
                    },
                    expected_seq=seq,
                )
                await self.check(projection)
                return
            except PodLogConflict:
                continue
        raise CredentialRefused("CREDENTIAL_CONFLICT")

    async def revoke(self, credential_id: str, generation: int) -> None:
        import re

        from hushh_mcp.services.pod_commit_log import PodLogConflict

        if not re.fullmatch(_ID, credential_id) or type(generation) is not int or generation < 1:
            raise CredentialRefused("CREDENTIAL_FENCE_INVALID")
        for _ in range(3):
            current, floors, seq = await self._snapshot()
            if generation < floors.get(credential_id, 0):
                raise CredentialRefused("CREDENTIAL_REVISION_STALE")
            if generation == floors.get(credential_id, 0) and credential_id not in current:
                return
            try:
                await self.log.append(
                    FENCE_KIND,
                    {
                        "owner_id": self.owner_id,
                        "pod_id": self.pod_id,
                        "credential_id": credential_id,
                        "generation": generation,
                    },
                    expected_seq=seq,
                )
                return
            except PodLogConflict:
                continue
        raise CredentialRefused("CREDENTIAL_CONFLICT")

    async def read_selected(self, selection) -> CredentialRecord:
        from hushh_mcp.services.pod_browser.information_export import BrowserExportSelection

        selection = BrowserExportSelection.model_validate(selection)
        if self.load_current is None:
            raise CredentialRefused("CREDENTIAL_AUTHORITY_UNAVAILABLE")
        return await self.load_current(selection)

    async def get_current(self, credential_id: str) -> WebsiteCredentialProjection:
        current, _, _ = await self._snapshot()
        projection = current.get(credential_id)
        if projection is None:
            raise CredentialRefused("CREDENTIAL_UNAVAILABLE")
        updated = await self.check(projection)
        if updated is not None and updated != projection:
            await self.publish(updated)
            return updated
        return projection

    async def list_current(
        self, *, origin: str | None = None
    ) -> tuple[WebsiteCredentialProjection, ...]:
        current, _, _ = await self._snapshot()
        admitted = []
        for projection in current.values():
            if origin is not None and origin not in projection.record.aad.boundOrigins:
                continue
            try:
                updated = await self.check(projection)
                if updated is not None and updated != projection:
                    await self.publish(updated)
                    projection = updated
            except Exception:
                continue
            admitted.append(projection)
        return tuple(admitted)


def browser_credential_source(*, store: CredentialProjectionStore, private_key: X25519PrivateKey):
    from hushh_mcp.services.pod_browser.credential_contracts import (
        CredentialDescriptor,
        CredentialLease,
    )

    class Source:
        async def catalog(self, binding, origin):
            if (binding.owner_id, binding.pod_id) != (store.owner_id, store.pod_id):
                raise CredentialRefused("CREDENTIAL_OWNER_REFUSED")
            return tuple(
                CredentialDescriptor(
                    handle=p.record.aad.credentialId,
                    origin=origin,
                    record_revision=p.record.aad.revision,
                    autonomy_policy=p.record.aad.autonomyPolicy,
                    policy_generation=p.record.aad.policyGeneration,
                    custody_generation=p.record.aad.custodyGeneration,
                )
                for p in await store.list_current(origin=origin)
                if origin in p.record.aad.boundOrigins
            )

        async def validate_transient(self, binding, aad, selection):
            if (binding.owner_id, binding.pod_id) != (store.owner_id, store.pod_id):
                raise CredentialRefused("CREDENTIAL_OWNER_REFUSED")
            if (aad.get("ownerId"), aad.get("hushhId"), aad.get("podKeyId")) != (
                store.owner_id,
                store.pod_id,
                store.pod_key_id,
            ):
                raise CredentialRefused("CREDENTIAL_RECIPIENT_REFUSED")
            record = await store.read_selected(selection)
            expected = record.aad
            if expected.generation <= await store.generation_floor(expected.credentialId):
                raise CredentialRefused("CREDENTIAL_REVISION_STALE")
            if (
                expected.autonomyPolicy != "vault_only"
                or record.podWrap is not None
                or (
                    aad.get("ownerId"),
                    aad.get("credentialId"),
                    aad.get("recordRevision"),
                    aad.get("policyGeneration"),
                    aad.get("custodyGeneration"),
                )
                != (
                    expected.ownerId,
                    expected.credentialId,
                    expected.revision,
                    expected.policyGeneration,
                    expected.custodyGeneration,
                )
                or aad.get("origin") not in expected.boundOrigins
            ):
                raise CredentialRefused("CREDENTIAL_REVISION_STALE")

        def open_transient(self, binding, request, envelope, selection, *, claim):
            from hushh_mcp.services.pod_browser.credential_transient import open_transient

            return open_transient(
                self, binding, request, envelope, selection, private_key=private_key, claim=claim
            )

        @asynccontextmanager
        async def open(self, binding, descriptor):
            if (binding.owner_id, binding.pod_id) != (store.owner_id, store.pod_id):
                raise CredentialRefused("CREDENTIAL_OWNER_REFUSED")

            async def checked_projection():
                current = await store.get_current(descriptor.handle)
                aad = current.record.aad
                if (
                    descriptor.record_revision,
                    descriptor.policy_generation,
                    descriptor.custody_generation,
                    descriptor.autonomy_policy,
                ) != (
                    aad.revision,
                    aad.policyGeneration,
                    aad.custodyGeneration,
                    aad.autonomyPolicy,
                ) or descriptor.origin not in aad.boundOrigins:
                    raise CredentialRefused("CREDENTIAL_REVISION_STALE")
                return current

            async def recheck():
                await checked_projection()

            projection = await checked_projection()
            opened = open_credential_record(
                projection.record,
                private_key,
                owner_id=store.owner_id,
                pod_id=store.pod_id,
                pod_key_id=store.pod_key_id,
            )
            lease = CredentialLease(
                username=bytearray(opened["username"].encode()),
                password=bytearray(opened["password"].encode()),
                totp_secret=bytearray(opened["totpSecret"].encode())
                if opened.get("totpSecret")
                else None,
                recheck=recheck,
            )
            opened.clear()
            try:
                await recheck()
                yield lease
            finally:
                lease.clear()

    return Source()


def production_credential_store(
    *,
    log,
    owner_id: str,
    pod_id: str,
    pod_key_id: str,
    environment: Literal["development", "uat"],
    incarnation: str,
    check: Callable[[], Awaitable[None]],
) -> CredentialProjectionStore:
    """Live grant/source/recipient checks, shared by owner import and Browser use."""
    import time

    from hushh_mcp.services.pod_browser.contracts import BrowserBinding
    from hushh_mcp.services.pod_browser.information import ScopedProjectionReader
    from hushh_mcp.services.pod_browser.information_export import PodScopedExports
    from hushh_mcp.services.pod_config import resolve_pod_config
    from hushh_mcp.services.pod_hub_client import PodHubClient
    from hushh_mcp.services.pod_self_registration import pod_key_is_durable, pod_keypair

    async def held(binding):
        await check()
        if (binding.owner_id, binding.pod_id, binding.incarnation) != (
            owner_id,
            pod_id,
            incarnation,
        ) or pod_keypair().key_id != pod_key_id:
            raise CredentialRefused("CREDENTIAL_RECIPIENT_REFUSED")
        config = await resolve_pod_config(log, hushh_id=pod_id)
        if config.session_only_lockdown:
            raise CredentialRefused("CREDENTIAL_SESSION_ONLY")

    client = PodHubClient(timeout_seconds=10)
    reader = ScopedProjectionReader(PodScopedExports(client, held))

    async def latest_selection(selection):
        from hushh_mcp.services.pod_browser.information_export import BrowserExportSelection
        from hushh_mcp.services.pod_object_version import run_write_to_completion

        await check()

        def read():
            response = client.post(
                "/api/one/pod/browser-approval/export/current",
                json=selection.model_dump(mode="json"),
            )
            try:
                if response.status_code != 200 or len(response.content) > 16384:
                    raise CredentialRefused("CREDENTIAL_AUTHORITY_UNAVAILABLE")
                return response.json()
            finally:
                response.close()

        updated = BrowserExportSelection.model_validate(await run_write_to_completion(read))
        if (
            updated.model_dump(exclude={"field"}) != selection.model_dump(exclude={"field"})
            or (updated.field.domain, updated.field.path, updated.field.grant_ref)
            != (selection.field.domain, selection.field.path, selection.field.grant_ref)
            or updated.field.export_revision < selection.field.export_revision
            or updated.field.source_content_revision < selection.field.source_content_revision
            or updated.field.source_manifest_revision < selection.field.source_manifest_revision
        ):
            raise CredentialRefused("CREDENTIAL_REVISION_STALE")
        await check()
        return updated

    async def load_current(selection):
        if (
            (selection.owner_id, selection.pod_id, selection.pod_key_id)
            != (owner_id, pod_id, pod_key_id)
            or selection.field.domain != "credentials"
            or not selection.field.path.startswith("secrets.")
        ):
            raise CredentialRefused("CREDENTIAL_SCOPE_REFUSED")
        binding = BrowserBinding(
            owner_id=owner_id,
            pod_id=pod_id,
            incarnation=incarnation,
            task_id="credential_authority",
            environment=environment,
            expires_at=int(time.time()) + 60,
        )
        await held(binding)
        selected = await latest_selection(selection)
        source = await reader.read(binding, selected.field)
        record = CredentialRecord.model_validate(
            source.get("secrets", {}).get(selection.field.path.split(".")[-1])
        )
        if record.podWrap is not None and not pod_key_is_durable():
            raise CredentialRefused("CREDENTIAL_CUSTODY_KEY_EPHEMERAL")
        if (
            record.aad.ownerId != owner_id
            or selection.field.path != f"secrets.{record.aad.credentialId}"
        ):
            raise CredentialRefused("CREDENTIAL_SCOPE_REFUSED")
        await held(binding)
        return selected, record

    async def current(projection):
        selected, record = await load_current(projection.selection)
        if record != projection.record:
            raise CredentialRefused("CREDENTIAL_REVISION_STALE")
        return WebsiteCredentialProjection(selection=selected, record=record)

    store = CredentialProjectionStore(
        log, owner_id=owner_id, pod_id=pod_id, pod_key_id=pod_key_id, check=current
    )

    async def record_only(selection):
        _, record = await load_current(selection)
        return record

    store.load_current = record_only
    return store


async def import_credential_projection(
    store: CredentialProjectionStore, selection
) -> WebsiteCredentialProjection:
    """Import only a current owner-approved export, never an uploaded record."""
    record = await store.read_selected(selection)
    projection = WebsiteCredentialProjection(selection=selection, record=record)
    await store.publish(projection)
    return projection
