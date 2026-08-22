from __future__ import annotations

import asyncio
import base64
import hashlib
from typing import Any

import pytest

import hushh_mcp.services.hushh_tech_client_service as client_service_module
from hushh_mcp.services.hushh_tech_client_service import (
    HushhTechClientError,
    HushhTechClientService,
    PostgresHushhTechClientStore,
)
from hushh_mcp.services.hushh_tech_legacy_proof import encode_synthetic_fixture_proof

UID_A = "firebase-uat-user-a"
UID_B = "firebase-uat-user-b"
APP_ID = "app_hushh_tech_uat"
AUDIENCE = "hushh-tech-uat"
REDIRECT = "https://uat.hushhtech.com/auth/hushh-research/callback"
VERIFIER = "v" * 43
CHALLENGE = (
    base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")
)
PROFILE_HASH = "a" * 64
NOW_MS = 1_787_227_200_000
SIGNING_KEY = "developer-token-" + ("s" * 48)


class MemoryStore:
    def __init__(self) -> None:
        self.launches: dict[str, dict[str, Any]] = {}
        self.links: list[dict[str, Any]] = []
        self.events: list[str] = []
        self.used_proof_sessions: set[str] = set()
        self.lock = asyncio.Lock()
        self.source_hash = PROFILE_HASH
        self.shadow: dict[str, dict[str, Any]] = {
            "profile": {
                "record_type": "profile",
                "payload": {"display_name": "Synthetic Ada"},
                "source_hash": PROFILE_HASH,
                "source_deleted": False,
                "updated_at_ms": NOW_MS,
            }
        }

    async def insert_launch_authorization(self, row: dict[str, Any]) -> None:
        self.launches[row["code_hash"]] = {**row, "consumed_at_ms": None}

    async def consume_launch_authorization(self, **expected: Any) -> dict[str, Any] | None:
        row = self.launches.get(expected["code_hash"])
        if (
            not row
            or row["consumed_at_ms"] is not None
            or row["code_challenge"] != expected["code_challenge"]
            or row["audience"] != expected["audience"]
            or row["redirect_uri"] != expected["redirect_uri"]
            or row["expires_at_ms"] <= expected["now_ms"]
        ):
            return None
        row["consumed_at_ms"] = expected["now_ms"]
        return dict(row)

    async def get_active_link(self, *, firebase_uid: str, app_id: str) -> dict[str, Any] | None:
        return next(
            (
                dict(row)
                for row in self.links
                if row["firebase_uid"] == firebase_uid
                and row["created_by_app_id"] == app_id
                and row["status"] == "active"
            ),
            None,
        )

    async def link_account(self, **values: Any) -> dict[str, Any]:
        async with self.lock:
            proof_session_id = str(values["proof_session_id"])
            if proof_session_id in self.used_proof_sessions:
                return {"outcome": "proof_replayed", "link": None}
            self.used_proof_sessions.add(proof_session_id)
            exact = next(
                (
                    row
                    for row in self.links
                    if row["status"] == "active"
                    and row["legacy_project"] == values["legacy_project"]
                    and row["legacy_user_uuid"] == values["legacy_user_uuid"]
                    and row["firebase_uid"] == values["firebase_uid"]
                    and row["created_by_app_id"] == values["app_id"]
                ),
                None,
            )
            if exact:
                self.events.append("relink_attempt")
                return {"outcome": "already_linked", "link": dict(exact)}
            conflict = next(
                (
                    row
                    for row in self.links
                    if row["status"] == "active"
                    and row["legacy_project"] == values["legacy_project"]
                    and (
                        row["legacy_user_uuid"] == values["legacy_user_uuid"]
                        or row["firebase_uid"] == values["firebase_uid"]
                    )
                ),
                None,
            )
            if conflict:
                self.events.append("conflict")
                return {"outcome": "conflict", "link": None}
            previous = next(
                (
                    row
                    for row in self.links
                    if row["status"] == "revoked"
                    and row["legacy_project"] == values["legacy_project"]
                    and row["legacy_user_uuid"] == values["legacy_user_uuid"]
                    and row["firebase_uid"] == values["firebase_uid"]
                    and row["created_by_app_id"] == values["app_id"]
                ),
                None,
            )
            row = {
                "link_id": f"link-{len(self.links) + 1}",
                "legacy_project": values["legacy_project"],
                "legacy_user_uuid": values["legacy_user_uuid"],
                "firebase_uid": values["firebase_uid"],
                "created_by_app_id": values["app_id"],
                "status": "active",
                "linked_at_ms": values["now_ms"],
            }
            self.links.append(row)
            self.events.append("recovered" if previous else "activated")
            return {"outcome": "recovered" if previous else "linked", "link": dict(row)}

    async def revoke_link(self, *, firebase_uid: str, app_id: str, now_ms: int):
        link = await self.get_active_link(firebase_uid=firebase_uid, app_id=app_id)
        if not link:
            return None
        source = next(row for row in self.links if row["link_id"] == link["link_id"])
        source.update(status="revoked", revoked_at_ms=now_ms)
        self.events.append("revoked")
        return dict(source)

    async def fixture_source_hash(self, **_: Any) -> str | None:
        return self.source_hash

    async def get_shadow_record(self, *, record_type: str, **_: Any) -> dict[str, Any] | None:
        record = self.shadow.get(record_type)
        return dict(record) if record else None


@pytest.fixture(autouse=True)
def enabled_env(monkeypatch: pytest.MonkeyPatch):
    values = {
        "ENVIRONMENT": "test",
        "HUSSH_TECH_CLIENT_ENABLED": "true",
        "HUSSH_TECH_LAUNCH_PEPPER": "unit-test-pepper",
        "HUSSH_TECH_DEVELOPER_APP_ID": APP_ID,
        "HUSSH_TECH_ALLOWED_AUDIENCE": AUDIENCE,
        "HUSSH_TECH_ALLOWED_REDIRECT_URIS": REDIRECT,
        "HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST": f"{UID_A},{UID_B}",
        "HUSSH_TECH_SHADOW_MAX_AGE_MS": "604800000",
        "HUSSH_TECH_PROXY_AUDIENCE": "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
        "HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS": (
            "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
        ),
        "RATE_LIMIT_STORAGE_URI": "redis://10.0.0.2:6379",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def proof(
    *,
    legacy_uuid: str,
    source_hash: str = PROFILE_HASH,
    session_id: str = "synthetic-session-001",
    firebase_uid: str = UID_A,
    app_id: str = APP_ID,
    audience: str = AUDIENCE,
    extra: dict[str, object] | None = None,
    signing_key: str = SIGNING_KEY,
):
    payload: dict[str, object] = {
        "firebase_uid": firebase_uid,
        "app_id": app_id,
        "audience": audience,
        "legacy_project": "hushh-tech-uat-synthetic",
        "legacy_user_uuid": legacy_uuid,
        "source_hash": source_hash,
        "session_id": session_id,
        "issued_at_ms": NOW_MS - 1_000,
        "expires_at_ms": NOW_MS + 60_000,
    }
    payload.update(extra or {})
    return encode_synthetic_fixture_proof(payload, signing_key=signing_key)


class _AsyncContext:
    def __init__(self, value=None) -> None:
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *_args):
        return False


class _QueryCaptureConnection:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def transaction(self):
        return _AsyncContext()

    async def fetchrow(self, query: str, *args):
        self.calls.append((query, args))
        return None


class _QueryCapturePool:
    def __init__(self, connection: _QueryCaptureConnection) -> None:
        self.connection = connection

    def acquire(self):
        return _AsyncContext(self.connection)


@pytest.mark.asyncio
async def test_store_link_reads_and_revocation_are_pinned_to_synthetic_project(
    monkeypatch: pytest.MonkeyPatch,
):
    connection = _QueryCaptureConnection()

    async def pool():
        return _QueryCapturePool(connection)

    monkeypatch.setattr(client_service_module, "get_pool", pool)
    store = PostgresHushhTechClientStore()
    assert await store.get_active_link(firebase_uid=UID_A, app_id=APP_ID) is None
    assert await store.revoke_link(firebase_uid=UID_A, app_id=APP_ID, now_ms=NOW_MS) is None

    read_query, read_args = connection.calls[0]
    revoke_query, revoke_args = connection.calls[1]
    assert "legacy_project = $3" in read_query
    assert read_args == (UID_A, APP_ID, "hushh-tech-uat-synthetic")
    assert "legacy_project = $4" in revoke_query
    assert revoke_args == (UID_A, APP_ID, NOW_MS, "hushh-tech-uat-synthetic")


@pytest.mark.asyncio
async def test_launch_pkce_is_exact_single_use_and_expires():
    store = MemoryStore()
    service = HushhTechClientService(store=store)
    authorization = await service.authorize_launch(
        firebase_uid=UID_A,
        audience=AUDIENCE,
        redirect_uri=REDIRECT,
        code_challenge=CHALLENGE,
        code_challenge_method="S256",
        firebase_valid_after_ms=123_000,
        now_ms=NOW_MS,
    )
    exchanged = await service.exchange_launch(
        code=authorization.code,
        code_verifier=VERIFIER,
        audience=AUDIENCE,
        redirect_uri=REDIRECT,
        now_ms=NOW_MS + 1,
    )
    assert exchanged["firebase_uid"] == UID_A
    assert exchanged["firebase_valid_after_ms"] == 123_000

    with pytest.raises(HushhTechClientError, match="invalid or expired"):
        await service.exchange_launch(
            code=authorization.code,
            code_verifier=VERIFIER,
            audience=AUDIENCE,
            redirect_uri=REDIRECT,
            now_ms=NOW_MS + 2,
        )

    expired = await service.authorize_launch(
        firebase_uid=UID_A,
        audience=AUDIENCE,
        redirect_uri=REDIRECT,
        code_challenge=CHALLENGE,
        code_challenge_method="S256",
        firebase_valid_after_ms=123_000,
        now_ms=NOW_MS,
    )
    with pytest.raises(HushhTechClientError) as error:
        await service.exchange_launch(
            code=expired.code,
            code_verifier=VERIFIER,
            audience=AUDIENCE,
            redirect_uri=REDIRECT,
            now_ms=NOW_MS + 60_001,
        )
    assert error.value.state == "UNAUTHENTICATED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("audience", "wrong-product"),
        ("redirect_uri", "https://evil.example/callback"),
        ("code_challenge_method", "plain"),
        ("code_challenge", "a" * 44),
        ("code_challenge", "." * 43),
        ("code_challenge", "~" * 43),
    ],
)
async def test_launch_rejects_wrong_audience_redirect_and_pkce(field: str, value: str):
    values = {
        "firebase_uid": UID_A,
        "audience": AUDIENCE,
        "redirect_uri": REDIRECT,
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
        "firebase_valid_after_ms": 123_000,
        "now_ms": NOW_MS,
    }
    values[field] = value
    with pytest.raises(HushhTechClientError) as error:
        await HushhTechClientService(store=MemoryStore()).authorize_launch(**values)
    assert error.value.state == "UNAUTHENTICATED"


@pytest.mark.asyncio
async def test_link_never_uses_email_and_conflicts_are_fail_closed():
    legacy_uuid = "00000000-0000-4000-8000-000000000101"
    store = MemoryStore()
    service = HushhTechClientService(store=store)
    with pytest.raises(HushhTechClientError) as email_error:
        await service.verify_and_link_account(
            firebase_uid=UID_A,
            app_id=APP_ID,
            legacy_session_proof=proof(legacy_uuid=legacy_uuid, extra={"email": "a@example.com"}),
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS,
        )
    assert email_error.value.state == "LINK_REQUIRED"

    linked = await service.verify_and_link_account(
        firebase_uid=UID_A,
        app_id=APP_ID,
        legacy_session_proof=proof(legacy_uuid=legacy_uuid),
        legacy_proof_signing_key=SIGNING_KEY,
        now_ms=NOW_MS,
    )
    assert linked["state"] == "READY"
    assert linked["reused"] is False
    assert linked["recovered"] is False

    reused = await service.verify_and_link_account(
        firebase_uid=UID_A,
        app_id=APP_ID,
        legacy_session_proof=proof(
            legacy_uuid=legacy_uuid,
            session_id="synthetic-session-002",
        ),
        legacy_proof_signing_key=SIGNING_KEY,
        now_ms=NOW_MS + 1,
    )
    assert reused["reused"] is True

    with pytest.raises(HushhTechClientError) as conflict:
        await service.verify_and_link_account(
            firebase_uid=UID_B,
            app_id=APP_ID,
            legacy_session_proof=proof(
                legacy_uuid=legacy_uuid,
                session_id="synthetic-session-003",
                firebase_uid=UID_B,
            ),
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS + 2,
        )
    assert conflict.value.state == "LINK_CONFLICT"


@pytest.mark.asyncio
async def test_concurrent_first_link_produces_one_mapping_and_one_conflict():
    legacy_uuid = "00000000-0000-4000-8000-000000000101"
    store = MemoryStore()
    service = HushhTechClientService(store=store)

    results = await asyncio.gather(
        service.verify_and_link_account(
            firebase_uid=UID_A,
            app_id=APP_ID,
            legacy_session_proof=proof(
                legacy_uuid=legacy_uuid,
                session_id="synthetic-session-concurrent-a",
            ),
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS,
        ),
        service.verify_and_link_account(
            firebase_uid=UID_B,
            app_id=APP_ID,
            legacy_session_proof=proof(
                legacy_uuid=legacy_uuid,
                session_id="synthetic-session-concurrent-b",
                firebase_uid=UID_B,
            ),
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS,
        ),
        return_exceptions=True,
    )
    assert sum(isinstance(result, HushhTechClientError) for result in results) == 1
    assert len([row for row in store.links if row["status"] == "active"]) == 1


@pytest.mark.asyncio
async def test_legacy_proof_requires_signature_and_is_consumed_once():
    legacy_uuid = "00000000-0000-4000-8000-000000000101"
    store = MemoryStore()
    service = HushhTechClientService(store=store)
    signed = proof(legacy_uuid=legacy_uuid, session_id="synthetic-session-one-time")

    await service.verify_and_link_account(
        firebase_uid=UID_A,
        app_id=APP_ID,
        legacy_session_proof=signed,
        legacy_proof_signing_key=SIGNING_KEY,
        now_ms=NOW_MS,
    )

    with pytest.raises(HushhTechClientError) as replay:
        await service.verify_and_link_account(
            firebase_uid=UID_A,
            app_id=APP_ID,
            legacy_session_proof=signed,
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS + 1,
        )
    assert replay.value.state == "LINK_REQUIRED"

    with pytest.raises(HushhTechClientError) as forged:
        await service.verify_and_link_account(
            firebase_uid=UID_A,
            app_id=APP_ID,
            legacy_session_proof=proof(
                legacy_uuid=legacy_uuid,
                session_id="synthetic-session-forged",
                signing_key="wrong-developer-token-" + ("x" * 48),
            ),
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS + 2,
        )
    assert forged.value.state == "LINK_REQUIRED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("proof_overrides", "request_app_id"),
    [
        ({"firebase_uid": UID_B}, APP_ID),
        ({"app_id": "app_other_product"}, APP_ID),
        ({"audience": "other-audience"}, APP_ID),
    ],
)
async def test_legacy_proof_is_bound_to_uid_app_and_audience(
    proof_overrides: dict[str, str],
    request_app_id: str,
):
    legacy_uuid = "00000000-0000-4000-8000-000000000101"
    store = MemoryStore()
    service = HushhTechClientService(store=store)
    with pytest.raises(HushhTechClientError) as error:
        await service.verify_and_link_account(
            firebase_uid=UID_A,
            app_id=request_app_id,
            legacy_session_proof=proof(
                legacy_uuid=legacy_uuid,
                session_id=f"synthetic-binding-{next(iter(proof_overrides))}",
                **proof_overrides,
            ),
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS,
        )
    assert error.value.state == "LINK_REQUIRED"
    assert store.links == []
    assert store.used_proof_sessions == set()


@pytest.mark.asyncio
async def test_hash_mismatch_revoke_and_stale_shadow_states():
    legacy_uuid = "00000000-0000-4000-8000-000000000101"
    store = MemoryStore()
    service = HushhTechClientService(store=store)
    with pytest.raises(HushhTechClientError) as mismatch:
        await service.verify_and_link_account(
            firebase_uid=UID_A,
            app_id=APP_ID,
            legacy_session_proof=proof(legacy_uuid=legacy_uuid, source_hash="b" * 64),
            legacy_proof_signing_key=SIGNING_KEY,
            now_ms=NOW_MS,
        )
    assert mismatch.value.state == "LINK_REQUIRED"

    await service.verify_and_link_account(
        firebase_uid=UID_A,
        app_id=APP_ID,
        legacy_session_proof=proof(legacy_uuid=legacy_uuid),
        legacy_proof_signing_key=SIGNING_KEY,
        now_ms=NOW_MS,
    )
    profile = await service.get_shadow(
        firebase_uid=UID_A,
        app_id=APP_ID,
        record_type="profile",
        now_ms=NOW_MS + 1,
    )
    assert profile["payload"] == {"display_name": "Synthetic Ada"}

    with pytest.raises(HushhTechClientError) as stale:
        await service.get_shadow(
            firebase_uid=UID_A,
            app_id=APP_ID,
            record_type="profile",
            now_ms=NOW_MS + 604_800_001,
        )
    assert stale.value.state == "STALE_SHADOW"
    revoked = await service.revoke_link(firebase_uid=UID_A, app_id=APP_ID, now_ms=NOW_MS + 2)
    assert revoked == {"state": "LINK_REQUIRED", "linked": False, "revoked": True}

    recovered = await service.verify_and_link_account(
        firebase_uid=UID_A,
        app_id=APP_ID,
        legacy_session_proof=proof(
            legacy_uuid=legacy_uuid,
            session_id="synthetic-session-recovery",
        ),
        legacy_proof_signing_key=SIGNING_KEY,
        now_ms=NOW_MS + 3,
    )
    assert recovered["state"] == "READY"
    assert recovered["recovered"] is True
    assert store.events[-1] == "recovered"


@pytest.mark.asyncio
async def test_production_and_non_allowlisted_users_stay_disabled(monkeypatch: pytest.MonkeyPatch):
    service = HushhTechClientService(store=MemoryStore())
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(HushhTechClientError) as production:
        await service.get_link_status(firebase_uid=UID_A, app_id=APP_ID)
    assert production.value.state == "FEATURE_DISABLED"

    monkeypatch.setenv("ENVIRONMENT", "test")
    with pytest.raises(HushhTechClientError) as cohort:
        await service.get_link_status(firebase_uid="firebase-user-outside-cohort", app_id=APP_ID)
    assert cohort.value.state == "FEATURE_DISABLED"


@pytest.mark.asyncio
async def test_uat_admission_requires_shared_redis_rate_limit_storage(
    monkeypatch: pytest.MonkeyPatch,
):
    service = HushhTechClientService(store=MemoryStore())
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("RATE_LIMIT_STORAGE_URI", raising=False)

    with pytest.raises(HushhTechClientError) as missing:
        await service.get_link_status(firebase_uid=UID_A, app_id=APP_ID)
    assert missing.value.state == "FEATURE_DISABLED"

    monkeypatch.setenv("RATE_LIMIT_STORAGE_URI", "memory://")
    with pytest.raises(HushhTechClientError) as process_local:
        await service.get_link_status(firebase_uid=UID_A, app_id=APP_ID)
    assert process_local.value.state == "FEATURE_DISABLED"

    monkeypatch.setenv("RATE_LIMIT_STORAGE_URI", "redis://10.0.0.2:6379")
    assert await service.get_link_status(firebase_uid=UID_A, app_id=APP_ID) == {
        "state": "LINK_REQUIRED",
        "linked": False,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing_key",
    [
        "HUSSH_TECH_LAUNCH_PEPPER",
        "HUSSH_TECH_DEVELOPER_APP_ID",
        "HUSSH_TECH_ALLOWED_AUDIENCE",
        "HUSSH_TECH_ALLOWED_REDIRECT_URIS",
        "HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST",
        "HUSSH_TECH_PROXY_AUDIENCE",
        "HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS",
    ],
)
async def test_every_admission_setting_is_required(
    monkeypatch: pytest.MonkeyPatch,
    missing_key: str,
):
    monkeypatch.delenv(missing_key, raising=False)
    with pytest.raises(HushhTechClientError) as disabled:
        await HushhTechClientService(store=MemoryStore()).get_link_status(
            firebase_uid=UID_A,
            app_id=APP_ID,
        )
    assert disabled.value.state == "FEATURE_DISABLED"
