"""One-use human-approved delivery to an active Browser worker's ephemeral key.

Only the Browser worker opens the ciphertext. The host carries opaque bytes and
rechecks owner/source authority; no password projection or standing pod key exists.
Owned buffers are cleared, without claiming Python/driver heap zeroization.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from contextlib import asynccontextmanager

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

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
            "sourceContentRevision",
            "sourceManifestRevision",
            "podId",
            "leaseKeyId",
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


def check_aad(binding, request, envelope, *, clock=None):
    import re

    try:
        _, _, _, aad = sealed.parse_envelope(envelope, purpose=PURPOSE)
        sealed.check_uuid4(aad["nonce"], purpose=PURPOSE)
        if (
            aad["purpose"],
            aad["ownerId"],
            aad["podId"],
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
        if not re.fullmatch(r"sec_[a-f0-9]{16}", aad["credentialId"]):
            raise ValueError()
        if any(
            type(aad[k]) is not int or aad[k] < 1
            for k in (
                "recordRevision",
                "sourceContentRevision",
                "sourceManifestRevision",
                "controlEpoch",
                "expiresAt",
            )
        ):
            raise ValueError()
        now = (clock or time.time)()
        if not now < aad["expiresAt"] <= min(now + 60, binding.expires_at):
            raise ValueError()
        if not isinstance(aad["leaseKeyId"], str) or not re.fullmatch(
            r"lease_[a-f0-9]{32}", aad["leaseKeyId"]
        ):
            raise ValueError()
        return aad
    except (ValueError, TypeError, KeyError):
        raise BrowserRefused("BROWSER_CREDENTIAL_TRANSIENT_REFUSED") from None


class CredentialLeaseKeys:
    """Task-local key custody inside the connected Browser worker only."""

    def __init__(self, binding):
        self.binding, self._pending = binding, None
        self._expiry = None

    def prepare(self, request):
        identity = (request.operation_id, request.origin, request.control_epoch)
        now = time.time()
        if self._pending and self._pending[0] == identity and self._pending[1]["expires_at"] > now:
            return dict(self._pending[1])
        self.clear()
        private = X25519PrivateKey.generate()
        public = {
            "id": "lease_" + secrets.token_hex(16),
            "public_key": sealed.b64url_encode(
                private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
            ),
            # The person may spend minutes unlocking/choosing. This recipient
            # lives only for this bounded task/epoch, while every delivered
            # ciphertext still has its independent <=60 second lease.
            "expires_at": self.binding.expires_at,
        }
        if public["expires_at"] <= now:
            raise BrowserRefused("BROWSER_BINDING_EXPIRED")
        self._pending = (identity, public, private)
        self._expiry = asyncio.get_running_loop().call_later(
            max(0, public["expires_at"] - time.time()), self.clear
        )
        return dict(public)

    def claim(self, request, aad):
        pending = self._pending
        self.clear()  # consume before any decrypt
        if (
            pending is None
            or pending[0] != (request.operation_id, request.origin, request.control_epoch)
            or pending[1]["id"] != aad["leaseKeyId"]
            or not time.time() < aad["expiresAt"] <= pending[1]["expires_at"]
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_LEASE_EXPIRED")
        return pending[2]

    def clear(self):
        # Cryptography's immutable key allocation cannot promise heap zeroization.
        self._pending = None
        if self._expiry is not None:
            self._expiry.cancel()
            self._expiry = None

    def retire_epoch(self, epoch):
        if self._pending is not None and self._pending[0][2] != epoch:
            self.clear()


@asynccontextmanager
async def open_worker_lease(keys, binding, request, envelope, *, check):
    lease, raw, body = None, bytearray(), {}
    aad = check_aad(binding, request, envelope)
    private = keys.claim(request, aad)
    try:
        opened, authenticated = sealed.open_envelope(
            envelope, purpose=PURPOSE, pod_private_key=private
        )
        raw.extend(opened)
        del opened, private
        if authenticated != aad:
            raise ValueError()
        body = sealed.parse_json_object(raw, purpose=PURPOSE)
        if set(body) not in ({"username", "password"}, {"username", "password", "totpSecret"}):
            raise ValueError()
        if any(
            not isinstance(body.get(k), str) or not 1 <= len(body[k].encode()) <= 4096
            for k in ("username", "password")
        ):
            raise ValueError()
        otp = body.get("totpSecret")
        if otp is not None and (not isinstance(otp, str) or not 16 <= len(otp) <= 128):
            raise ValueError()
        lease = CredentialLease(
            bytearray(body["username"].encode()),
            bytearray(body["password"].encode()),
            check,
            bytearray(otp.encode()) if otp else None,
        )
        body.clear()
        await check()
        yield lease
    except (ValueError, TypeError, KeyError):
        raise BrowserRefused("BROWSER_CREDENTIAL_TRANSIENT_REFUSED") from None
    finally:
        if lease:
            lease.clear()
        raw[:] = b"\0" * len(raw)
        body.clear()


class HumanCredentialSource:
    """Current owner/source metadata only, with no persistent secret read port."""

    def __init__(self, check_source):
        self._check_source = check_source

    async def validate_transient(self, binding, aad, selection=None):
        await self._check_source(binding, aad)

    async def catalog(self, binding, origin):
        return ()  # Selection happens exclusively in the unlocked owner's Secrets.

    @asynccontextmanager
    async def open_transient(self, binding, request, envelope, selection=None, *, claim):
        aad = check_aad(binding, request, envelope)
        await self.validate_transient(binding, aad)
        await claim()  # durable keyed nonce commitment, before worker unwrap
        lease = CredentialLease(
            bytearray(), bytearray(), lambda: self.validate_transient(binding, aad)
        )
        lease.envelope = envelope
        try:
            yield lease
        finally:
            lease.clear()


def production_credential_source(*, log, owner_id, pod_id, incarnation, check):
    from hushh_mcp.services.pod_config import resolve_pod_config
    from hushh_mcp.services.pod_hub_client import PodHubClient
    from hushh_mcp.services.pod_object_version import run_write_to_completion

    client = PodHubClient(timeout_seconds=10)

    async def current(binding, aad):
        await check()
        if (binding.owner_id, binding.pod_id, binding.incarnation) != (
            owner_id,
            pod_id,
            incarnation,
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_OWNER_CHANGED")
        if (await resolve_pod_config(log, hushh_id=pod_id)).session_only_lockdown:
            raise BrowserRefused("BROWSER_CREDENTIAL_SESSION_ONLY")

        def read():
            response = client.post(
                "/api/one/pod/browser-approval/credential-source",
                json={
                    "owner_id": owner_id,
                    "pod_id": pod_id,
                    "secret_id": aad["credentialId"],
                    "content_revision": aad["sourceContentRevision"],
                    "manifest_revision": aad["sourceManifestRevision"],
                },
            )
            try:
                if response.status_code != 200 or response.json() != {"current": True}:
                    raise BrowserRefused("BROWSER_CREDENTIAL_SOURCE_CHANGED")
            finally:
                response.close()

        await run_write_to_completion(read)
        await check()
        if (await resolve_pod_config(log, hushh_id=pod_id)).session_only_lockdown:
            raise BrowserRefused("BROWSER_CREDENTIAL_SESSION_ONLY")

    return HumanCredentialSource(current)
