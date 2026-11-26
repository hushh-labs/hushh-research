"""Recipient-sealed, one-use vault-only delivery. No persistent plaintext custody.

The shared envelope primitive and JSON parser create immutable temporary copies.
Only owned mutable buffers are overwritten; browser/driver heap erasure is not
claimed. Exact-image credential qualification gates use of this adapter.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager

from hushh_mcp.services import pod_sealed_envelope as sealed

from .contracts import BrowserRefused
from .credential_contracts import CredentialLease

PURPOSE = sealed.SealPurpose(
    name="website_credential_use",
    hkdf_info=b"hussh/website-credential-use/v1",
    aad_keys=frozenset(
        {
            "purpose",
            "ownerId",
            "credentialId",
            "recordRevision",
            "policyGeneration",
            "custodyGeneration",
            "hushhId",
            "podKeyId",
            "taskId",
            "incarnation",
            "controlEpoch",
            "origin",
            "operationId",
            "expiresAt",
            "nonce",
        }
    ),
    max_ciphertext_bytes=24576,
)


def check_aad(binding, request, envelope):
    try:
        _, _, _, aad = sealed.parse_envelope(envelope, purpose=PURPOSE)
        sealed.check_uuid4(aad["nonce"], purpose=PURPOSE)
        if (
            aad["purpose"],
            aad["ownerId"],
            aad["hushhId"],
            aad["taskId"],
            aad["incarnation"],
            aad["controlEpoch"],
            aad["origin"],
            aad["operationId"],
            aad["credentialId"],
        ) != (
            PURPOSE.name,
            binding.owner_id,
            binding.pod_id,
            binding.task_id,
            binding.incarnation,
            request.control_epoch,
            request.origin,
            request.operation_id,
            request.handle,
        ):
            raise ValueError()
        if any(
            type(aad[key]) is not int or aad[key] < 1
            for key in (
                "recordRevision",
                "policyGeneration",
                "custodyGeneration",
                "controlEpoch",
                "expiresAt",
            )
        ):
            raise ValueError()
        if not time.time() < aad["expiresAt"] <= min(time.time() + 60, binding.expires_at):
            raise ValueError()
        return aad
    except (ValueError, TypeError, KeyError):
        raise BrowserRefused("BROWSER_CREDENTIAL_TRANSIENT_REFUSED") from None


@asynccontextmanager
async def open_transient(source, binding, request, envelope, selection, *, private_key, claim):
    lease = None
    body = {}
    raw = bytearray()
    aad = check_aad(binding, request, envelope)

    async def current():
        check_aad(binding, request, envelope)
        await source.validate_transient(binding, aad, selection)

    try:
        await current()
        # Persist only a keyed nonce commitment, before unwrapping. A retry may
        # never decrypt or dispatch this envelope again after an uncertain exit.
        await claim()
        opened, authenticated = sealed.open_envelope(
            envelope, purpose=PURPOSE, pod_private_key=private_key
        )
        raw.extend(opened)
        del opened
        if authenticated != aad:
            raise ValueError()
        body = sealed.parse_json_object(raw, purpose=PURPOSE)
        if (
            set(body)
            not in (
                {"username", "password", "selection"},
                {"username", "password", "totpSecret", "selection"},
            )
            or body["selection"] != selection
        ):
            raise ValueError()
        if any(
            not isinstance(body.get(key), str) or not 1 <= len(body[key].encode("utf-8")) <= 4096
            for key in ("username", "password")
        ):
            raise ValueError()
        otp = body.get("totpSecret")
        if otp is not None and (not isinstance(otp, str) or not 16 <= len(otp) <= 128):
            raise ValueError()
        lease = CredentialLease(
            bytearray(body["username"].encode()),
            bytearray(body["password"].encode()),
            current,
            bytearray(otp.encode()) if otp else None,
        )
        body.clear()
        await current()
        yield lease
    except (ValueError, TypeError, KeyError):
        raise BrowserRefused("BROWSER_CREDENTIAL_TRANSIENT_REFUSED") from None
    finally:
        if lease is not None:
            lease.clear()
        raw[:] = b"\0" * len(raw)
        body.clear()
