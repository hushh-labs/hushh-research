"""Exact pod-recipient ciphertext retrieval; this never creates a PKM grant.

The hub admits the existing encrypted export. Only the owner pod decrypts it.
Missing owner-approved exports remain unavailable, with no replica fallback.
"""

from __future__ import annotations

import asyncio
import base64
import time

from pydantic import Field

from hushh_mcp.consent.export_envelope import (
    ConsentExportEnvelopeSubmissionV2,
    connector_key_fingerprint,
    validate_export_envelope_submission,
)

from .contracts import BrowserBinding, BrowserRefused, StrictContract
from .information import AuthorizedScopedExport, InformationField


class BrowserExportSelection(StrictContract):
    owner_id: str = Field(min_length=1, max_length=256)
    pod_id: str = Field(min_length=1, max_length=256)
    pod_key_id: str = Field(min_length=1, max_length=128)
    field: InformationField


def selected_export(row: dict | None, selection: BrowserExportSelection, public_key: str) -> dict:
    field = selection.field
    if not row or not field.grant_ref:
        raise BrowserRefused("BROWSER_INFORMATION_UNAVAILABLE")
    expected = {
        "user_id": selection.owner_id,
        "app_id": "agent_one",
        "grant_id": field.grant_ref,
        "scope": field.scope,
        "connector_key_id": selection.pod_key_id,
        "envelope_version": 2,
        "export_revision": field.export_revision,
        "source_content_revision": field.source_content_revision,
        "source_manifest_revision": field.source_manifest_revision,
        "recipient_key_fingerprint": connector_key_fingerprint(public_key),
    }
    if any(row.get(key) != value for key, value in expected.items()) or not row.get(
        "is_strict_zero_knowledge"
    ):
        raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")
    try:
        envelope = ConsentExportEnvelopeSubmissionV2.model_validate(
            {
                "version": 2,
                "export_id": row["export_id"],
                "aad": row["envelope_aad"],
                "aad_sha256": row["envelope_aad_sha256"],
                "ciphertext_sha256": row["ciphertext_sha256"],
                "ciphertext_bytes": row["ciphertext_bytes"],
            }
        )
        ciphertext = str(row["encrypted_data"])
        if (
            len(ciphertext) > 90_000
            or envelope.ciphertext_bytes > 65536
            or envelope.aad.expires_at_ms <= time.time() * 1000
        ):
            raise ValueError("bounded export required")
        validate_export_envelope_submission(
            envelope=envelope,
            encrypted_data=ciphertext,
            expected_app_id="agent_one",
            expected_grant_id=field.grant_ref,
            expected_revision=field.export_revision,
            expected_scope=field.scope,
            expected_scope_handle=str(row["scope_handle"]),
            expected_recipient_fingerprint=expected["recipient_key_fingerprint"],
        )
        return {
            "envelope": envelope.model_dump(mode="json"),
            "wrapped_key_bundle": row["wrapped_key_bundle"],
            "iv": row["iv"],
            "tag": row["tag"],
            "ciphertext": ciphertext,
            "source_content_revision": field.source_content_revision,
            "source_manifest_revision": field.source_manifest_revision,
        }
    except (KeyError, ValueError, TypeError):
        raise BrowserRefused("BROWSER_INFORMATION_EXPORT_INVALID") from None


async def require_export_grant(
    service, row: dict | None, selection: BrowserExportSelection
) -> None:
    from hushh_mcp.consent.token import validate_token_with_db

    if row is None:
        raise BrowserRefused("BROWSER_INFORMATION_UNAVAILABLE")
    bearer = str(row.get("consent_token") or "")
    valid, _, token = await validate_token_with_db(bearer, expected_scope=selection.field.scope)
    if (
        not valid
        or token is None
        or str(token.user_id) != selection.owner_id
        or str(token.agent_id) != "agent_one"
        or token.scope_str != selection.field.scope
    ):
        raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")

    def lineage():
        result = (
            service._get_db()
            .table("consent_audit")
            .select("user_id,agent_id,scope,request_id")
            .eq("token_id", bearer)
            .eq("action", "CONSENT_GRANTED")
            .order("issued_at", desc=True)
            .limit(1)
            .execute()
        )
        return result.data or []

    rows = await asyncio.to_thread(lineage)
    expected = {
        "user_id": selection.owner_id,
        "agent_id": "agent_one",
        "scope": selection.field.scope,
        "request_id": selection.field.grant_ref,
    }
    if len(rows) != 1 or any(rows[0].get(k) != v for k, v in expected.items()):
        raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")


class PodScopedExports:
    def __init__(self, client, check) -> None:
        self._client, self._check = client, check

    async def load_current(
        self, binding: BrowserBinding, field: InformationField
    ) -> AuthorizedScopedExport:
        from hushh_mcp.services.pod_object_version import run_write_to_completion
        from hushh_mcp.services.pod_self_registration import pod_keypair

        await self._check(binding)
        if field.grant_ref is None:
            raise BrowserRefused("BROWSER_INFORMATION_UNAVAILABLE")
        key = pod_keypair()
        selection = BrowserExportSelection(
            owner_id=binding.owner_id, pod_id=binding.pod_id, pod_key_id=key.key_id, field=field
        )

        def read():
            response = self._client.post(
                "/api/one/pod/browser-approval/export", json=selection.model_dump(mode="json")
            )
            try:
                if response.status_code != 200 or len(response.content) > 131072:
                    raise BrowserRefused("BROWSER_INFORMATION_UNAVAILABLE")
                return response.json()
            finally:
                response.close()

        try:
            result = await run_write_to_completion(read)
            envelope = ConsentExportEnvelopeSubmissionV2.model_validate(result["envelope"])
            package = AuthorizedScopedExport(
                binding=binding,
                field=field,
                app_id="agent_one",
                grant_id=field.grant_ref,
                recipient_fingerprint=connector_key_fingerprint(key.public_key_b64),
                source_content_revision=result["source_content_revision"],
                source_manifest_revision=result["source_manifest_revision"],
                envelope=envelope,
                wrapped_key_bundle=result["wrapped_key_bundle"],
                iv_b64=result["iv"],
                tag_b64=result["tag"],
                ciphertext=base64.b64decode(result["ciphertext"], validate=True),
                connector_private_key=key.private_key,
            )
        except Exception:
            raise BrowserRefused("BROWSER_INFORMATION_UNAVAILABLE") from None
        await self._check(binding)
        if pod_keypair().key_id != key.key_id:
            raise BrowserRefused("BROWSER_INFORMATION_GRANT_REFUSED")
        return package
