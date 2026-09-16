"""DB-backed proof of the information sharing lifecycle: request, approve, export, decrypt.

The real-Postgres counterpart of ``test_information_sharing_lifecycle_e2e.py``.
The routes, the request service, the approval route's connector and envelope
verification, the consent ledger (``consent_audit`` + ``consent_exports``),
the correlation tables, and the identity cache are all the real thing against
a real database. Only two identity dependencies are overridden (the acting
person, as a verified token would resolve) and one resolver is faked: the
owner's requestable catalogue, which needs a materialised profile and a
connection graph that are out of scope for a lifecycle proof.

Marked ``db`` (see pyproject markers): it needs the Cloud SQL Auth Proxy tunnel
at 127.0.0.1:6543 and credentials in the environment. It is NOT in the offline
CI test manifest; run it deliberately with::

    DB_HOST=127.0.0.1 DB_PORT=6543 DB_USER=... DB_PASSWORD=... DB_NAME=... \\
        uv run pytest tests/test_information_sharing_lifecycle_db.py -m db

When the proxy port is closed, or no credentials reach the pool, it skips
rather than failing. It seeds two synthetic people and removes them again,
including the deletion tombstones their removal records.
"""

from __future__ import annotations

import contextvars
import json
import os
import socket
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio

# A reachable Postgres is required; default to the documented tunnel port but let
# the environment override it. These are set before the connection pool is first used.
os.environ.setdefault("DB_HOST", "127.0.0.1")
os.environ.setdefault("DB_PORT", "6543")
os.environ.setdefault("DB_USER", "postgres")
os.environ.setdefault("DB_NAME", "postgres")

from api.middleware import require_firebase_auth, require_vault_owner_token  # noqa: E402
from api.routes import consent  # noqa: E402
from api.routes.one import information_requests  # noqa: E402
from db.connection import get_pool  # noqa: E402
from hushh_mcp.consent.export_envelope import (  # noqa: E402
    ConsentExportAadV2,
    connector_key_fingerprint,
)
from hushh_mcp.consent.export_projection import decrypt_scoped_export_package  # noqa: E402
from hushh_mcp.services.information_request_service import (  # noqa: E402
    InformationRequestService,
)
from tests.helpers.consent_export_crypto import (  # noqa: E402
    encrypt_export_for_connector,
    generate_connector_key,
)

pytestmark = pytest.mark.db

RUN = uuid.uuid4().hex[:10]
OWNER_UID = f"e2e-share-owner-{RUN}"
REQUESTER_UID = f"e2e-share-requester-{RUN}"
CONNECTOR_KEY_ID = f"e2e-share-key-{RUN}"
SCOPE = "attr.identity.legal_name"
SCOPE_REF = "psr_legal_name"
PURPOSE = "Confirm the name on the lease before we sign it"
HOUR_MS = 60 * 60 * 1000

_acting_user: contextvars.ContextVar[str] = contextvars.ContextVar(
    "acting_user_db", default=OWNER_UID
)


def _proxy_listening() -> bool:
    host = os.environ.get("DB_HOST", "127.0.0.1")
    port = int(os.environ.get("DB_PORT", "6543"))
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


async def _db_reachable() -> bool:
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute("SELECT 1")
        return True
    except Exception:
        return False


class _Catalogue:
    """The one faked seam: the owner's requestable catalogue.

    The real resolver reads the owner's materialised profile through the
    connection graph. Seeding both for two throwaway people is not what this
    proof is about; the ledger, the envelope, and the export are.
    """

    def __init__(self, subject_user_id: str, public_person_ref: str) -> None:
        self._subject_user_id = subject_user_id
        self._public_person_ref = public_person_ref

    def resolve_scope_refs(self, *, viewer_user_id: str, public_person_ref: str, scope_refs):
        assert viewer_user_id == REQUESTER_UID
        assert public_person_ref == self._public_person_ref
        assert list(scope_refs) == [SCOPE_REF]
        return {"user_id": self._subject_user_id}, [
            {
                "scopeRef": SCOPE_REF,
                "scope": SCOPE,
                "label": "Legal name",
                "description": "Name used on official records",
                "sensitivity": "sensitive",
            }
        ]


async def _seed(connector_public_b64: str) -> str:
    """Two people with vaults, profiles, names, and the requester's connector key."""
    now_ms = int(time.time() * 1000)
    pool = await get_pool()
    async with pool.acquire() as conn:
        for uid, name in ((OWNER_UID, "Alex Morgan"), (REQUESTER_UID, "Priya Raman")):
            await conn.execute(
                """INSERT INTO vault_keys
                   (user_id, vault_key_hash, primary_method, recovery_encrypted_vault_key,
                    recovery_salt, recovery_iv, created_at, updated_at)
                   VALUES ($1, 'e2e', 'passphrase', 'e2e', 'e2e', 'e2e', $2, $2)
                   ON CONFLICT (user_id) DO NOTHING""",
                uid,
                now_ms,
            )
            await conn.execute(
                "INSERT INTO actor_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
                uid,
            )
            await conn.execute(
                """INSERT INTO actor_identity_cache (user_id, display_name, source)
                   VALUES ($1, $2, 'e2e')
                   ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name""",
                uid,
                name,
            )
        await conn.execute(
            """INSERT INTO one_kyc_client_connectors
               (user_id, connector_key_id, connector_public_key, connector_wrapping_alg,
                public_key_fingerprint, status)
               VALUES ($1, $2, $3, 'X25519-AES256-GCM', $4, 'active')""",
            REQUESTER_UID,
            CONNECTOR_KEY_ID,
            connector_public_b64,
            connector_key_fingerprint(connector_public_b64),
        )
        owner_ref = await conn.fetchval(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id = $1", OWNER_UID
        )
    return str(owner_ref)


async def _cleanup() -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        for uid in (OWNER_UID, REQUESTER_UID):
            await conn.execute("DELETE FROM consent_exports WHERE user_id = $1", uid)
            await conn.execute("DELETE FROM consent_audit WHERE user_id = $1", uid)
            await conn.execute(
                "DELETE FROM one_information_request_bundles WHERE requester_user_id = $1", uid
            )
            # Cascades: identity cache, connector keys, and the profile spine.
            await conn.execute("DELETE FROM actor_profiles WHERE user_id = $1", uid)
            await conn.execute("DELETE FROM vault_keys WHERE user_id = $1", uid)
            # Removing an account records a deletion tombstone by trigger; a
            # synthetic person leaves none behind.
            await conn.execute(
                "DELETE FROM account_deletion_tombstones WHERE firebase_uid = $1", uid
            )


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[dict[str, Any]]:
    import httpx
    from fastapi import FastAPI
    from httpx import ASGITransport

    if not _proxy_listening():
        pytest.skip("Cloud SQL Auth Proxy not listening on DB_HOST:DB_PORT; run -m db with it up")
    if not await _db_reachable():
        pytest.skip("Postgres not reachable; set DB_USER/DB_PASSWORD/DB_NAME to run -m db tests")

    connector_private, connector_public_b64 = generate_connector_key()
    await _cleanup()
    owner_ref = await _seed(connector_public_b64)

    monkeypatch.setattr(
        information_requests,
        "_service",
        lambda: InformationRequestService(profiles=_Catalogue(OWNER_UID, owner_ref)),
    )
    monkeypatch.setattr(consent, "_consent_exports", {})

    app = FastAPI()
    app.include_router(information_requests.router)
    app.include_router(consent.router)

    async def _vault_owner() -> dict[str, str]:
        return {"user_id": _acting_user.get()}

    async def _firebase() -> str:
        return _acting_user.get()

    app.dependency_overrides[require_vault_owner_token] = _vault_owner
    app.dependency_overrides[require_firebase_auth] = _firebase
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://e2e") as client:
        try:
            yield {
                "client": client,
                "owner_ref": owner_ref,
                "connector_private": connector_private,
                "connector_public_b64": connector_public_b64,
            }
        finally:
            await _cleanup()


@pytest.mark.asyncio
async def test_request_approve_export_decrypt_against_postgres(world: dict[str, Any]) -> None:
    client = world["client"]
    plaintext = {"identity": {"legal_name": "Alex Morgan"}}

    # 1) The requester asks for the owner's legal name for three days.
    _acting_user.set(REQUESTER_UID)
    resp = await client.post(
        "/api/one/information-requests",
        json={
            "person_ref": world["owner_ref"],
            "scope_refs": [SCOPE_REF],
            "purpose": PURPOSE,
            "duration_seconds": 72 * 3600,
            "connector_key_id": CONNECTOR_KEY_ID,
            "idempotency_key": f"lease-signing-{RUN}",
        },
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()
    bundle_id = created["bundleId"]
    request_id = created["items"][0]["requestId"]
    assert created["items"][0]["status"] == "pending"

    # 2) The owner sees it, with the requester's name, and encrypts for the
    #    requester's connector key. The envelope expiry is the 72h shown.
    _acting_user.set(OWNER_UID)
    resp = await client.get(
        "/api/consent/pending/lookup", params={"userId": OWNER_UID, "request_id": request_id}
    )
    assert resp.status_code == 200, resp.text
    pending = resp.json()["items"][0]
    assert pending["requester_label"] == "Priya Raman"
    assert pending["bundle_id"] == bundle_id
    metadata = pending["metadata"]
    assert metadata["connector_public_key"] == world["connector_public_b64"]
    assert metadata["expiry_hours"] == 72

    aad = ConsentExportAadV2(
        app_id=metadata["developer_app_id"],
        grant_id=request_id,
        export_id=str(uuid.uuid4()),
        revision=1,
        machine_scope=pending["scope"],
        scope_handle=metadata["scope_handle"],
        recipient_key_fingerprint=connector_key_fingerprint(metadata["connector_public_key"]),
        expires_at_ms=int(time.time() * 1000) + 72 * HOUR_MS,
    )
    package = encrypt_export_for_connector(
        plaintext,
        connector_public_key_b64=metadata["connector_public_key"],
        connector_key_id=CONNECTOR_KEY_ID,
        aad=aad,
    )
    resp = await client.post(
        "/api/consent/pending/approve",
        json={
            "userId": OWNER_UID,
            "requestId": request_id,
            "durationHours": 168,
            "sourceContentRevision": 1,
            "sourceManifestRevision": 1,
            **package,
        },
    )
    assert resp.status_code == 200, resp.text
    approved = resp.json()
    assert approved["status"] == "approved"
    assert approved["bundle_id"] == bundle_id
    assert approved["granted_scope"] == SCOPE

    # 3) The requester reads the export and decrypts it with their own key.
    _acting_user.set(REQUESTER_UID)
    resp = await client.get(f"/api/one/information-requests/{bundle_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["status"] == "granted"
    resp = await client.get(f"/api/one/information-requests/{bundle_id}/exports")
    assert resp.status_code == 200, resp.text
    exports = resp.json()["exports"]
    assert len(exports) == 1
    encrypted = exports[0]["encryptedExport"]
    assert encrypted["export_envelope"]["version"] == 2
    assert encrypted["export_refresh_status"] == "current"
    assert approved["consent_token"] not in resp.text
    assert OWNER_UID not in resp.text
    assert (
        decrypt_scoped_export_package(
            wrapped_key_bundle=encrypted["wrapped_key_bundle"],
            iv_b64=encrypted["iv"],
            tag_b64=encrypted["tag"],
            ciphertext=encrypted["encrypted_data"],
            connector_private_key=world["connector_private"],
            export_envelope=encrypted["export_envelope"],
        )
        == plaintext
    )

    # 4) The ledger says what happened: 72h granted (168h asked), and one read.
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT action, metadata::text AS metadata FROM consent_audit
               WHERE user_id = $1 AND request_id = $2 ORDER BY issued_at""",
            OWNER_UID,
            request_id,
        )
        stored = await conn.fetchrow(
            """SELECT envelope_version, refresh_status, connector_key_id, grant_id, app_id
               FROM consent_exports WHERE consent_token = $1""",
            approved["consent_token"],
        )
    assert [row["action"] for row in rows] == ["REQUESTED", "CONSENT_GRANTED", "EXPORT_READ"]
    assert json.loads(rows[1]["metadata"])["approved_duration_hours"] == 72
    assert stored is not None
    assert stored["envelope_version"] == 2
    assert stored["refresh_status"] == "current"
    assert stored["connector_key_id"] == CONNECTOR_KEY_ID
    assert stored["grant_id"] == request_id
    assert stored["app_id"] == "agent_one"
