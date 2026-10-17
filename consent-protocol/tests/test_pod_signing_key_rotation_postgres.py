"""Rotating a pod key revokes the signing key derived from the old one, on PostgreSQL.

Rotating the pod key is the remedy for a compromised one. The signing key is derived
from that same private key, so it must die with it, whichever writer moved the pod
key and whatever the pull that moved it carried: a signing key from an image that
publishes none, a malformed one, one pulled with the hub flag off, or one from a pod
that named no HusshID. Before migration 947's ``zzz_pod_signing_key_follows_pod_key``
trigger, every one of those left the row with the NEW pod key and the OLD signing
key, so whoever held the superseded key kept full hub identity.

This runs the real collector, provisioning service, registry repository, verifier
and identity store against the whole dev migration chain, so the trigger is proven
alongside every guard trigger already on ``personal_agent_registry``.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import create_engine, text

from db.db_client import DatabaseClient
from hushh_mcp.services import (
    personal_agent_provisioning_service,
    pod_key_collector,
    pod_lifecycle_log,
)
from hushh_mcp.services import pod_request_identity_store as identity_store
from hushh_mcp.services import pod_request_signing as prs
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from hushh_mcp.services.pod_hub_client import POD_IDENTITY_HEADER
from hushh_mcp.services.pod_key_collector import collect_pod_key_if_pending
from hushh_mcp.services.pod_mcp_approval import PodMcpTerms, _principal_holds_row
from hushh_mcp.services.pod_request_identity_store import PodRequestIdentityStore
from hushh_mcp.services.pod_request_verifier import (
    SignedOutcome,
    SignedRequest,
    verify_signed_request,
)
from tests.pkm_conformance import postgres_harness

pytestmark = pytest.mark.skipif(
    postgres_harness.find_pg_bin() is None, reason="PostgreSQL unavailable"
)

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db/migrations"
AUD = "https://hub.example"
UID = "uid-rotation"
HUSHH_ID = "ha1_rotation"
POD_URL = "https://pod.example"
OLD_SIGNING = Ed25519PrivateKey.from_private_bytes(bytes([7]) * 32)
NEW_SIGNING = Ed25519PrivateKey.from_private_bytes(bytes([8]) * 32)
# 944 is the chat-history cutover: it touches no registry table and refuses to run
# without the chat tables, so it is the one dev migration this chain leaves out.
_UNRELATED = {"944_one_chat_history_legacy_cutover.sql"}


def _signing(key: Ed25519PrivateKey) -> tuple[str, str]:
    public = prs.public_key_b64(key)
    return public, prs.signing_key_id(public)


@pytest.fixture(scope="module")
def pg():
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = postgres_harness.TempPostgres()
    try:
        server.start()
        legacy = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
        audit = legacy.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
        server.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + audit)
        server.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
        server.execute("CREATE TABLE agent_chat_conversations (id UUID PRIMARY KEY)")
        server.execute(
            "CREATE TABLE one_adk_sessions (app_name TEXT, user_id TEXT, session_id TEXT, "
            "PRIMARY KEY(app_name,user_id,session_id))"
        )
        for name in (
            "029_setup_state_rename.sql",
            "201_account_deletion_tombstones.sql",
            "114_one_action_directive_ledger.sql",
            "248_adk_chat_action_authority.sql",
        ):
            server.apply_file(MIGRATIONS / name)
        manifest = json.loads((ROOT / "db/dev_migration_manifest.json").read_text())
        for name in manifest["ordered_migrations"]:
            if name not in _UNRELATED:
                server.apply_file(MIGRATIONS / "parked" / name)
        yield server
    finally:
        postgres_harness.MIGRATIONS = old
        server.stop()


@pytest.fixture
def db(pg):
    """A provisioned, LATCHED row: pod key K1 with the signing key derived from it."""
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    old_key = generate_pod_keypair()
    public, kid = _signing(OLD_SIGNING)
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM pod_request_nonces"))
        conn.execute(text("DELETE FROM personal_agent_registry"))
        conn.execute(
            text(
                "INSERT INTO personal_agent_registry (user_id,hushh_id,phone_e164_hash,status,"
                "pod_pubkey,pod_key_id,pod_key_wrapping_alg,pod_signing_pubkey,"
                "pod_signing_key_id,identity_mode,backend_metadata) VALUES (:u,:h,'phone-hash',"
                "'provisioned',:pk,:pkid,:alg,:sk,:skid,'signed',CAST(:meta AS jsonb))"
            ),
            {
                "u": UID,
                "h": HUSHH_ID,
                "pk": old_key.public_key_b64,
                "pkid": old_key.key_id,
                "alg": old_key.wrapping_alg,
                "sk": public,
                "skid": kid,
                "meta": json.dumps({"url": POD_URL}),
            },
        )
    yield DatabaseClient(engine)
    engine.dispose()


def _row(db) -> dict:
    with db.engine.begin() as conn:
        return dict(
            conn.execute(text("SELECT * FROM personal_agent_registry WHERE user_id=:u"), {"u": UID})
            .mappings()
            .one()
        )


def _execute(db, sql: str, params: dict | None = None) -> None:
    with db.engine.begin() as conn:
        conn.execute(text(sql), params or {})


# -- the trigger, whoever writes -------------------------------------------------------


def test_moving_the_pod_key_alone_drops_the_signing_key_and_keeps_the_latch(db):
    _execute(db, "UPDATE personal_agent_registry SET pod_pubkey='a-different-pod-key'")
    row = _row(db)
    assert row["pod_signing_pubkey"] is None and row["pod_signing_key_id"] is None
    assert row["identity_mode"] == "signed"


def test_moving_the_pod_key_with_its_own_signing_key_keeps_the_new_one(db):
    public, kid = _signing(NEW_SIGNING)
    _execute(
        db,
        "UPDATE personal_agent_registry SET pod_pubkey='a-different-pod-key', "
        "pod_signing_pubkey=:sk, pod_signing_key_id=:skid",
        {"sk": public, "skid": kid},
    )
    assert _row(db)["pod_signing_key_id"] == kid


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE personal_agent_registry SET pod_pubkey=pod_pubkey",
        "UPDATE personal_agent_registry SET status='provisioned', health_state='healthy'",
        "UPDATE personal_agent_registry SET backend_metadata="
        'backend_metadata || \'{"observed":{"imageTag":"v2"}}\'::jsonb',
    ],
)
def test_writes_that_leave_the_pod_key_alone_keep_the_signing_key(db, statement):
    _execute(db, statement)
    assert _row(db)["pod_signing_key_id"] == _signing(OLD_SIGNING)[1]


# -- end to end: the hub's own pull rotates, the old signing key stops working ---------


class _Grant:
    async def issue_standing_pkm_read(self, user_id: str, ledger: Any = None) -> dict:
        return {"expiresAt": "2030-01-01T00:00:00Z"}


class _Response:
    status_code = 200

    def __init__(self, body: dict) -> None:
        self._body = body

    def json(self) -> dict:
        return self._body


class _Session:
    """Whatever the real pod at the hub's recorded address publishes."""

    def __init__(self, body: dict) -> None:
        self.body = body

    def get(self, url: str, **_: Any) -> _Response:
        assert url == f"{POD_URL}/pod/public-key", "the hub pulls only from its own record"
        return _Response(self.body)


def _published(case: str) -> dict:
    keypair = generate_pod_keypair()
    public, kid = _signing(NEW_SIGNING)
    body = {
        "hushhId": HUSHH_ID,
        "podPublicKey": keypair.public_key_b64,
        "podKeyId": keypair.key_id,
        "podKeyWrappingAlg": keypair.wrapping_alg,
        "podSigningKey": public,
        "podSigningKeyId": kid,
        "podSigningAlg": "ed25519",
    }
    if case == "image_publishes_none":
        for field in ("podSigningKey", "podSigningKeyId", "podSigningAlg"):
            body.pop(field)
    elif case == "malformed_signing_key":
        body["podSigningKeyId"] = _signing(OLD_SIGNING)[1]  # a kid the key does not derive
    elif case == "no_husshid_reported":
        body.pop("hushhId")
    return body


@pytest.fixture
def hub(db, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setattr(pod_key_collector, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(pod_key_collector, "_identity_token", lambda _audience: None)

    async def _no_narrative(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(pod_lifecycle_log, "append", _no_narrative)
    monkeypatch.setattr(
        personal_agent_provisioning_service, "record_provisioning_feed_event_safe", _no_narrative
    )
    monkeypatch.setattr(identity_store, "default_store", lambda: PodRequestIdentityStore(client=db))
    repo = PersonalAgentRegistryRepo(client=db)
    service = PersonalAgentProvisioningService(registry=repo, grant=_Grant())
    return repo, service


def _rotate(repo, service, body: dict) -> str | None:
    row = asyncio.run(repo.get(UID))
    return asyncio.run(
        collect_pod_key_if_pending(
            row, service=service, session=_Session(body), allow_rotation=True
        )
    )


def _verify(db, repo, service, body: dict, key: Ed25519PrivateKey):
    path, payload = "/api/one/pod/heartbeat", b'{"imageTag":"v2"}'
    headers = prs.sign_pod_request(
        key, aud=AUD, hushh_id=HUSHH_ID, method="POST", path=path, query_pairs=[], body=payload
    )
    headers[POD_IDENTITY_HEADER] = HUSHH_ID

    async def refresh(row: dict) -> str | None:
        return await collect_pod_key_if_pending(
            row, service=service, session=_Session(body), allow_rotation=True
        )

    return asyncio.run(
        verify_signed_request(
            SignedRequest(headers=headers, method="POST", path=path, query_pairs=[], body=payload),
            aud=AUD,
            registry=repo,
            store=PodRequestIdentityStore(client=db),
            refresh=refresh,
        )
    )


def _review(pod_key_id: str) -> PodMcpTerms:
    """MCP terms a caller can fill in: the CURRENT pod key id is not a secret."""
    return PodMcpTerms(
        ownerId=UID,
        hushhId=HUSHH_ID,
        podKeyId=pod_key_id,
        environment="dev",
        epoch=1,
        conversationId="private-thread",
        connectorId="custom_test",
        toolName="mcp_" + "a" * 40,
        callId="call",
        catalogRevision="rev1",
        commitment="b" * 64,
    )


@pytest.mark.parametrize(
    "case",
    ["image_publishes_none", "malformed_signing_key", "hub_flag_off", "no_husshid_reported"],
)
def test_a_rotation_without_a_usable_signing_key_revokes_the_old_one(db, hub, monkeypatch, case):
    repo, service = hub
    if case == "hub_flag_off":
        monkeypatch.setattr(pod_key_collector, "pod_hub_identity_auth_enabled", lambda: False)
    old_kid = _signing(OLD_SIGNING)[1]
    body = _published(case)

    assert _rotate(repo, service, body) == "provisioned"

    row = _row(db)
    assert row["pod_pubkey"] == body["podPublicKey"], "the pod key rotated"
    assert row["pod_signing_pubkey"] is None and row["pod_signing_key_id"] is None
    assert row["identity_mode"] == "signed", "the latch survives: no Google-only downgrade"

    # The old key's holder signs. Its unknown kid can only trigger the hub's own pull,
    # which binds whatever the real pod now publishes, never the old key. With the
    # flag back on that is the new pod's own signing key: the row heals itself.
    monkeypatch.setattr(pod_key_collector, "pod_hub_identity_auth_enabled", lambda: True)
    stale = _verify(db, repo, service, body, OLD_SIGNING)
    assert stale.outcome is SignedOutcome.KEY_UNRESOLVED and stale.pod is None
    healed = _signing(NEW_SIGNING)[1] if case == "hub_flag_off" else None
    assert _row(db)["pod_signing_key_id"] == healed
    # The MCP fence compares the signed principal to the row under its lock.
    principal = prs.VerifiedPod(HUSHH_ID, key_id=old_kid)
    assert not _principal_holds_row(principal, _review(row["pod_key_id"]), _row(db))


def test_a_rotation_with_its_signing_key_moves_both_and_only_the_new_one_verifies(db, hub):
    repo, service = hub
    body = _published("valid")

    assert _rotate(repo, service, body) == "provisioned"
    assert _row(db)["pod_signing_key_id"] == _signing(NEW_SIGNING)[1]

    assert _verify(db, repo, service, body, OLD_SIGNING).outcome is SignedOutcome.KEY_UNRESOLVED
    fresh = _verify(db, repo, service, body, NEW_SIGNING)
    assert fresh.outcome is SignedOutcome.VERIFIED
    assert fresh.pod == prs.VerifiedPod(HUSHH_ID, key_id=_signing(NEW_SIGNING)[1])


def test_a_re_adopted_row_rotating_mid_provision_drops_the_old_signing_key(db, hub):
    """Adoption rewrites the row to ``connecting`` and leaves the old keys in place;
    the pull then falls through to the full attach path with the new pod key."""
    repo, service = hub
    _execute(db, "UPDATE personal_agent_registry SET status='connecting'")
    body = _published("image_publishes_none")

    assert _rotate(repo, service, body) == "provisioned"

    row = _row(db)
    assert row["pod_pubkey"] == body["podPublicKey"]
    assert row["pod_signing_key_id"] is None
