"""Authentication boundaries, real PostgreSQL atomicity and delivery admission."""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import secrets
import time
from pathlib import Path
from types import SimpleNamespace

import asyncpg
import dns.resolver
import httpx
import pytest
import pytest_asyncio
from cryptography.exceptions import InvalidTag
from fastapi import FastAPI

from hushh_mcp.services.email_auth.config import EmailAuthConfig
from hushh_mcp.services.email_auth.contracts import (
    POLICY_VERSION,
    DomainDecision,
    EmailAuthError,
    PayloadCipher,
    normalize_email,
)
from hushh_mcp.services.email_auth.delivery import EmailAuthDeliveryWorker
from hushh_mcp.services.email_auth.domain_policy import DomainEvaluator, RiskSnapshot
from hushh_mcp.services.email_auth.service import EmailAuthService
from hushh_mcp.services.email_auth.store import PostgresEmailAuthStore


def release_module():
    path = Path(__file__).resolve().parents[3] / "scripts/ops/email_auth_uat_release.py"
    spec = importlib.util.spec_from_file_location("email_auth_release", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("missing_key", [None, "EMAIL_AUTH_LOOKUP_KEY"])
def test_enabled_release_requires_all_distinct_keys_before_sender_authority(
    monkeypatch, missing_key
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.email_auth.one_sender import OneSenderTokenProvider

    module = release_module()
    monkeypatch.setattr(os, "environ", os.environ.copy())
    for name in (
        *module.KEYS,
        "EMAIL_AUTH_ENABLED",
        "EMAIL_AUTH_MAIL_API_KEY",
        "EMAIL_AUTH_RISK_MANIFEST",
        "EMAIL_AUTH_MAIL_API_ENDPOINT",
        "EMAIL_AUTH_MAIL_FROM",
        "FIREBASE_ADMIN_CREDENTIALS_JSON",
        "SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON",
    ):
        monkeypatch.delenv(name, raising=False)
    values = {
        name: base64.b64encode(bytes([index]) * 32).decode()
        for index, name in enumerate(module.KEYS, 1)
    }
    values.update(
        {
            "MAIL_API_KEY": "synthetic-one-key",
            "FIREBASE_ADMIN_CREDENTIALS_JSON": "synthetic-credential",
        }
    )
    if missing_key:
        values[missing_key] = ""
    monkeypatch.setattr(module, "read_secret", values.__getitem__)
    monkeypatch.setattr(module, "reviewed_risk", lambda: SimpleNamespace(version="fixture"))
    requests = []

    def post(url, **kwargs):
        requests.append(kwargs)
        assert kwargs["json"] == {"transport": "one-delegated"}
        return httpx.Response(400, json={"error": "Invalid One OTP request"})

    monkeypatch.setattr(module.httpx, "post", post)
    sender = AsyncMock(return_value="synthetic-ephemeral-token")
    monkeypatch.setattr(OneSenderTokenProvider, "__init__", lambda self: None)
    monkeypatch.setattr(OneSenderTokenProvider, "get", sender)
    if missing_key:
        with pytest.raises(EmailAuthError):
            module.preflight()
        assert not requests
        sender.assert_not_called()
    else:
        result = module.preflight()
        assert result["sender_ready"]
        assert result["mail_consumer"] == "one"
        assert "synthetic" not in json.dumps(result)


@pytest.mark.parametrize("attested", [True, False])
def test_policy_activation_uses_only_the_attested_database_and_process_credentials(
    monkeypatch, attested
):
    module = release_module()
    from urllib.parse import unquote, urlsplit

    values = {
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": module.INSTANCE
        if attested
        else "another:region:instance",
        "DB_HOST": "127.0.0.1",
        "DB_PORT": "6543",
        "DB_NAME": "postgres",
        "HUSSH_RELEASE_ENVIRONMENT": "uat",
        "DB_USER": "synthetic-user",
        "DB_PASSWORD": "synthetic-password/@",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(module, "reviewed_risk", lambda: SimpleNamespace(version="fixture"))
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        assert "synthetic-password" not in " ".join(command)
        target = urlsplit(kwargs["env"]["EMAIL_AUTH_POLICY_DATABASE_URL"])
        assert target.hostname == "127.0.0.1" and target.port == 6543
        assert unquote(target.password) == values["DB_PASSWORD"]
        assert "email_auth_policy.py" in command[1]
        return SimpleNamespace(
            returncode=0, stdout=json.dumps({"action": "activated", "risk": "fixture"})
        )

    monkeypatch.setattr(module.subprocess, "run", run)
    if attested:
        assert module.activate("release-actor", "a" * 40)["action"] == "activated"
        assert len(calls) == 1
    else:
        with pytest.raises(module.ReleaseError, match="database_target"):
            module.activate("release-actor", "a" * 40)
        assert calls == []


@pytest.mark.parametrize("available", [True, False])
def test_enabled_candidate_must_offer_email_sign_in_before_promotion(monkeypatch, available):
    module = release_module()
    monkeypatch.setattr(
        module.httpx,
        "get",
        lambda *args, **kwargs: httpx.Response(200, json={"enabled": available}),
    )
    url = "https://candidate---consent-protocol-example-uc.a.run.app"
    if available:
        assert module.verify_candidate(url)["candidate_ready"]
    else:
        with pytest.raises(module.ReleaseError, match="candidate_capabilities"):
            module.verify_candidate(url)


@pytest.mark.parametrize("recovers", [True, False])
@pytest.mark.parametrize("failure", [httpx.ReadTimeout, httpx.ConnectError])
def test_candidate_readiness_retries_only_bounded_transport_reads(monkeypatch, recovers, failure):
    module = release_module()
    calls, sleeps = [], []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        if recovers and len(calls) == 2:
            return httpx.Response(200, json={"enabled": True})
        raise failure("private diagnostic must not escape")

    monkeypatch.setattr(module.httpx, "get", get)
    monkeypatch.setattr(module.time, "sleep", sleeps.append)
    url = "https://candidate---consent-protocol-example-uc.a.run.app"
    if recovers:
        assert module.verify_candidate(url)["candidate_ready"]
    else:
        stage = "candidate_timeout" if failure is httpx.ReadTimeout else "candidate_transport"
        with pytest.raises(module.ReleaseError, match=f"^{stage}$"):
            module.verify_candidate(url)
    assert len(calls) == 2
    assert all(call == (url + "/api/auth/email/capabilities", {"timeout": 30}) for call in calls)
    assert sleeps == [2]


@pytest.mark.parametrize(
    "response,stage",
    [
        (httpx.Response(200, content=b"not json"), "candidate_response"),
        (httpx.Response(200, json=[]), "candidate_response"),
        (httpx.Response(200, json={"enabled": "true"}), "candidate_capabilities"),
        (httpx.Response(503), "candidate_capabilities"),
    ],
)
def test_candidate_invalid_readiness_is_refused_without_retry(monkeypatch, response, stage):
    module = release_module()
    calls = []

    def get(*args, **kwargs):
        calls.append(args)
        return response

    monkeypatch.setattr(module.httpx, "get", get)
    with pytest.raises(module.ReleaseError, match=f"^{stage}$"):
        module.verify_candidate("https://candidate---consent-protocol-example-uc.a.run.app")
    assert len(calls) == 1


class Answer(list):
    def __init__(self, items, ttl=300):
        super().__init__(items)
        self.expiration = time.time() + ttl
        self.response = SimpleNamespace(answer=[])


class Resolver:
    def __init__(self, mx="mx.example.com", addresses=("8.8.8.8",)):
        self.mx, self.addresses = mx, addresses

    async def resolve(self, name, record, **kwargs):
        if record == "MX":
            if self.mx is None:
                raise dns.resolver.NoAnswer()
            return Answer([SimpleNamespace(exchange=self.mx)])
        if record == "AAAA":
            raise dns.resolver.NoAnswer()
        return Answer(self.addresses)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mx,addresses,status",
    [
        ("mx.example.com", ("8.8.8.8",), "approved"),
        (".", ("8.8.8.8",), "denied"),
        (None, ("8.8.8.8",), "pending"),
        ("mx.example.com", ("8.8.8.8", "127.0.0.1"), "denied"),
        ("mx.example.com", ("::ffff:8.8.8.8",), "denied"),
    ],
)
async def test_domain_admission_requires_usable_safe_mail_route(mx, addresses, status):
    risk = RiskSnapshot(frozenset({"disposable.example"}), "fixture", time.time() + 3600)
    evaluator = DomainEvaluator(risk, Resolver(mx, addresses))
    assert (await evaluator.evaluate("example.com")).status == status


def test_parsing_and_authenticated_encryption_reject_substitution():
    assert normalize_email("Person+tag@EXAMPLE.com") == ("person+tag@example.com", "example.com")
    for value in ["a@127.0.0.1", "a@localhost", "a@examp\nle.com", "a..b@example.com"]:
        with pytest.raises(EmailAuthError):
            normalize_email(value)
    cipher = PayloadCipher(secrets.token_bytes(32))
    sealed = cipher.seal("000001", "challenge:a:expiry:1")
    assert cipher.open(sealed, "challenge:a:expiry:1") == "000001"
    with pytest.raises(InvalidTag):
        cipher.open(sealed, "challenge:b:expiry:1")


@pytest.mark.asyncio
@pytest.mark.parametrize("sender,accepted", [("one@hushh.ai", True), ("ankit@hushh.ai", False)])
async def test_mail_api_adapter_uses_only_the_delegated_one_contract(sender, accepted):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.email_auth.delivery import MailApiTransport

    def handler(request):
        body = json.loads(request.content)
        assert set(body) == {"transport", "to", "code", "expiresInSeconds", "idempotencyKey"}
        assert body["transport"] == "one-delegated"
        assert request.headers["x-one-gmail-access-token"] == "synthetic-one-token"
        return httpx.Response(200, json={"success": True, "from": sender})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        transport = MailApiTransport(
            "https://hushh-mail-api-646258530541.us-central1.run.app",
            "synthetic-key",
            client=client,
            token_provider=SimpleNamespace(get=AsyncMock(return_value="synthetic-one-token")),
        )
        if accepted:
            await transport.send("person@example.com", "000001", "c" * 32, 240)
        else:
            with pytest.raises(RuntimeError):
                await transport.send("person@example.com", "000001", "c" * 32, 240)


@pytest.mark.parametrize("expiry", [float("nan"), float("inf"), -1])
def test_required_risk_expiry_must_be_finite(expiry):
    with pytest.raises(ValueError):
        RiskSnapshot(frozenset({"disposable.example"}), "fixture", expiry)


@pytest_asyncio.fixture
async def store():
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required for atomicity evidence.")
    url = url.replace("postgresql+psycopg2://", "postgresql://", 1)
    admin = await asyncpg.connect(url)
    schema = "email_auth_test_" + secrets.token_hex(8)
    await admin.execute(f'CREATE SCHEMA "{schema}"')
    pool = await asyncpg.create_pool(
        url, min_size=1, max_size=8, server_settings={"search_path": schema}
    )
    migration = Path(__file__).resolve().parents[2] / "db/migrations/359_independent_email_otp.sql"
    await pool.execute(migration.read_text())
    await pool.execute(migration.read_text())
    await pool.execute(
        "INSERT INTO email_auth_policy_state VALUES(TRUE,$1,'fixture')", POLICY_VERSION
    )
    await pool.execute("CREATE TABLE account_deletion_tombstones(user_id_hash TEXT PRIMARY KEY)")
    # Reproduce migration 201's immutable UID contract in this isolated schema.
    await pool.execute("""CREATE FUNCTION guard_immutable_uid() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'account identity reference is immutable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER immutable_uid BEFORE UPDATE ON email_auth_enrollments
      FOR EACH ROW EXECUTE FUNCTION guard_immutable_uid()""")
    try:
        yield PostgresEmailAuthStore(pool)
    finally:
        await pool.close()
        await admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
        await admin.close()


class Identity:
    def __init__(self):
        self.users = {}
        self.enrollment_calls = 0

    def find(self, email):
        return self.users.get(email)

    def provision(self, uid, email):
        self.users[email] = SimpleNamespace(uid=uid)

    def issue(self, uid, email):
        user = self.users.get(email)
        if not user or user.uid != uid:
            raise EmailAuthError("account_conflict", "Use your existing sign-in method.", 409)
        return "opaque-test-token"


class Evaluator:
    risk = RiskSnapshot(frozenset({"disposable.example"}), "fixture", time.time() + 3600)

    async def evaluate(self, domain):
        return DomainDecision(domain, "approved", "fixture", time.time() + 600, "fixture")

    async def certificate_evidence(self, domain):
        return "unavailable"


@pytest.fixture
def config(monkeypatch):
    values = {
        "EMAIL_AUTH_ENABLED": "true",
        "EMAIL_AUTH_RISK_MANIFEST": "fixture",
        "EMAIL_AUTH_MAIL_API_ENDPOINT": "https://hushh-mail-api-646258530541.us-central1.run.app",
        "EMAIL_AUTH_MAIL_API_KEY": secrets.token_urlsafe(32),
        "EMAIL_AUTH_MAIL_FROM": "one@hushh.ai",
        **{
            name: base64.b64encode(secrets.token_bytes(32)).decode()
            for name in [
                "EMAIL_AUTH_VERIFIER_KEY",
                "EMAIL_AUTH_PAYLOAD_KEY",
                "EMAIL_AUTH_LOOKUP_KEY",
            ]
        },
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return EmailAuthConfig.from_env()


def code_from_row(service, row):
    associated = (
        f"otp:{row['challenge_id']}:{row['destination_hash']}:{row['expires_at'].isoformat()}"
    )
    return json.loads(service.cipher.open(row["payload"], associated))["code"]


async def challenge(service, email="person@example.com"):
    binding = secrets.token_urlsafe(32)
    result = await service.request(email, binding, secrets.token_urlsafe(24), "client")
    row = await service.store.challenge(result["challenge_id"])
    return binding, row, code_from_row(service, row)


@pytest.mark.asyncio
async def test_concurrent_verification_consumes_exactly_once_and_failures_persist(store, config):
    identity = Identity()
    service = EmailAuthService(config, store, Evaluator(), identity)
    binding, row, code = await challenge(service)
    wrong = "000000" if code != "000000" else "000001"
    with pytest.raises(EmailAuthError):
        await service.verify(row["challenge_id"], wrong, binding)
    assert (await store.challenge(row["challenge_id"]))["attempts"] == 1
    outcomes = await asyncio.gather(
        *[service.verify(row["challenge_id"], code, binding) for _ in range(4)],
        return_exceptions=True,
    )
    assert (
        sum(isinstance(item, dict) and item.get("status") == "authenticated" for item in outcomes)
        == 1
    )
    assert (await store.challenge(row["challenge_id"]))["consumed_at"] is not None


@pytest.mark.asyncio
async def test_unseen_revocation_and_late_review_cannot_approve(store, config):
    await store.revoke_domain("unseen.example")
    service = EmailAuthService(config, store, Evaluator(), Identity())
    with pytest.raises(EmailAuthError):
        await service.request(
            "person@unseen.example", secrets.token_urlsafe(32), secrets.token_urlsafe(24), "client"
        )
    _, generation = await store.claim_review("example.com", "fixture", "review")
    await store.revoke_domain("example.com")
    decision = DomainDecision("example.com", "approved", "late", time.time() + 300, "fixture")
    assert await store.publish_review(decision, "review", generation) is None
    assert await store.pool.fetchval("SELECT COUNT(*) FROM email_auth_challenges") == 0


@pytest.mark.asyncio
async def test_existing_account_signs_in_directly_after_otp_without_provider_enrollment(
    store, config
):
    identity = Identity()
    identity.users["person@example.com"] = SimpleNamespace(uid="original-owner")
    service = EmailAuthService(config, store, Evaluator(), identity)
    binding, row, code = await challenge(service)
    proof = await service.verify(row["challenge_id"], code, binding)
    assert proof == {"status": "authenticated", "custom_token": "opaque-test-token"}
    assert await store.enrollment(row["destination_hash"]) == "original-owner"
    assert identity.enrollment_calls == 0
    final = await store.challenge(row["challenge_id"])
    assert final["expected_uid"] == "original-owner"
    assert final["destination_ciphertext"] is None
    with pytest.raises(EmailAuthError):
        await service.verify(row["challenge_id"], code, binding)


@pytest.mark.asyncio
async def test_verified_otp_never_replaces_another_active_uid_binding(store, config):
    identity = Identity()
    identity.users["person@example.com"] = SimpleNamespace(uid="current-firebase-owner")
    service = EmailAuthService(config, store, Evaluator(), identity)
    binding, row, code = await challenge(service)
    await store.reserve_new_identity(row["destination_hash"], "previous-owner")
    await store.activate_enrollment(row["destination_hash"], "previous-owner")
    with pytest.raises(EmailAuthError, match="existing sign-in"):
        await service.verify(row["challenge_id"], code, binding)
    assert await store.enrollment(row["destination_hash"]) == "previous-owner"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,limit", [("discover", 30), ("verify", 60)])
async def test_throttled_clients_cannot_drain_the_global_budget(store, kind, limit):
    async def request(client):
        if kind == "discover":
            await store.discovery_budget(client, "example.com")
        else:
            await store.verification_budget(client)

    for _ in range(limit):
        await request("exhausted-client")
    for _ in range(610):
        with pytest.raises(EmailAuthError):
            await request("exhausted-client")
    assert (
        await store.pool.fetchval(
            "SELECT count FROM email_auth_budgets WHERE budget_key=$1", kind + ":global"
        )
        == limit
    )
    await request("fresh-client")


@pytest.mark.asyncio
async def test_resend_cooldown_does_not_charge_send_quotas(store, config):
    service = EmailAuthService(config, store, Evaluator(), Identity())
    await challenge(service)
    for _ in range(5):
        with pytest.raises(EmailAuthError):
            await service.request(
                "person@example.com", secrets.token_urlsafe(32), secrets.token_urlsafe(24), "client"
            )
    budgets = await store.pool.fetch(
        "SELECT count FROM email_auth_budgets WHERE budget_key LIKE 'send:%'"
    )
    assert budgets and all(row["count"] == 1 for row in budgets)


@pytest.mark.asyncio
@pytest.mark.parametrize("interruption", ["domain-generation", "deleted"])
async def test_finalization_rechecks_policy_generation_and_deletion_after_mint(
    store, config, monkeypatch, interruption
):
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    identity = Identity()
    identity.users["person@example.com"] = SimpleNamespace(uid="canonical-owner")
    service = EmailAuthService(config, store, Evaluator(), identity)
    binding, row, code = await challenge(service)
    original = store.finalize_login

    async def interrupt(challenge_id, browser_hash, uid, risk_version, mint):
        async def changed():
            token = await mint()
            if interruption == "domain-generation":
                await store.pool.execute(
                    "UPDATE email_auth_domain_decisions SET generation=generation+1"
                )
            else:
                await store.pool.execute(
                    "INSERT INTO account_deletion_tombstones VALUES($1)",
                    account_deletion_user_hash(uid),
                )
            return token

        return await original(challenge_id, browser_hash, uid, risk_version, changed)

    monkeypatch.setattr(store, "finalize_login", interrupt)
    with pytest.raises(EmailAuthError):
        await service.verify(row["challenge_id"], code, binding)
    assert await store.enrollment(row["destination_hash"]) is None
    assert (await store.challenge(row["challenge_id"]))["enrollment_finalized_at"] is None


@pytest.mark.asyncio
async def test_primary_email_rebind_preserves_uid_and_rejects_a_stale_old_email_proof(
    store, config, monkeypatch
):
    identity = Identity()
    identity.users["person@example.com"] = SimpleNamespace(uid="canonical-owner")
    service = EmailAuthService(config, store, Evaluator(), identity)
    binding, old, code = await challenge(service)
    await service.verify(old["challenge_id"], code, binding)
    await store.pool.execute(
        "UPDATE email_auth_challenges SET created_at=created_at-INTERVAL '61 seconds'"
    )
    old_binding, stale, stale_code = await challenge(service)
    entered, release = asyncio.Event(), asyncio.Event()
    original = store.finalize_login

    async def pause(challenge_id, *args):
        if challenge_id == stale["challenge_id"]:
            entered.set()
            await release.wait()
        return await original(challenge_id, *args)

    monkeypatch.setattr(store, "finalize_login", pause)
    pending = asyncio.create_task(service.verify(stale["challenge_id"], stale_code, old_binding))
    await asyncio.wait_for(entered.wait(), 2)
    identity.users["new@example.com"] = identity.users.pop("person@example.com")
    new_binding, new, new_code = await challenge(service, "new@example.com")
    assert (await service.verify(new["challenge_id"], new_code, new_binding))[
        "status"
    ] == "authenticated"
    release.set()
    with pytest.raises(EmailAuthError):
        await pending
    assert await store.enrollment(old["destination_hash"]) is None
    assert await store.enrollment(new["destination_hash"]) == "canonical-owner"


@pytest.mark.asyncio
async def test_rollback_scrubs_pending_and_consumed_proofs_but_preserves_bindings(store, config):
    service = EmailAuthService(config, store, Evaluator(), Identity())
    _, pending, _ = await challenge(service)
    _, consumed, _ = await challenge(service, "other@example.com")
    await store.pool.execute(
        "UPDATE email_auth_challenges SET consumed_at=clock_timestamp(),enrollment_ticket_hash='synthetic-ticket' WHERE challenge_id=$1",
        consumed["challenge_id"],
    )
    await store.reserve_new_identity(pending["destination_hash"], "retained-owner")
    rollback = (
        Path(__file__).resolve().parents[2]
        / "db/migrations/rollback/359_independent_email_otp.rollback.sql"
    )
    for _ in range(2):
        await store.pool.execute(rollback.read_text())
    for challenge_id in [pending["challenge_id"], consumed["challenge_id"]]:
        row = await store.challenge(challenge_id)
        assert row["payload"] is None and row["destination_ciphertext"] is None
        assert row["enrollment_ticket_hash"] is None and row["cancelled_at"]
    assert await store.enrollment(pending["destination_hash"]) == "retained-owner"


@pytest.mark.parametrize(
    "case,allowed",
    [
        ("verified", True),
        ("active-created", True),
        ("linked-deprovisioned", True),
        ("unverified", False),
        ("changed-email", False),
        ("disabled", False),
        ("deleted", False),
        ("created-deprovisioned", False),
    ],
)
def test_firebase_otp_issue_rechecks_canonical_identity_before_mint(monkeypatch, case, allowed):
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )
    from hushh_mcp.services.email_auth.identity import FirebaseEmailIdentity

    claims = {}
    if case in {"active-created", "created-deprovisioned"}:
        claims["workosOrigin"] = "created"
    if case == "linked-deprovisioned":
        claims["workosOrigin"] = "linked"
    if case in {"created-deprovisioned", "linked-deprovisioned"}:
        claims["workosDeprovisionedAt"] = "recorded-offboarding"
    user = SimpleNamespace(
        uid="canonical-owner",
        email="different@example.com" if case == "changed-email" else "person@example.com",
        email_verified=case != "unverified",
        disabled=case == "disabled",
        custom_claims=claims,
    )
    minted = []

    def mint(uid, claims, app):
        minted.append((uid, claims))
        return b"synthetic-otp-token"

    auth = SimpleNamespace(get_user=lambda uid, app: user, create_custom_token=mint)
    monkeypatch.setattr(FirebaseEmailIdentity, "_context", staticmethod(lambda: (auth, object())))
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "is_tombstoned",
        staticmethod(lambda uid: case == "deleted"),
    )
    if allowed:
        assert (
            FirebaseEmailIdentity().issue(user.uid, "person@example.com") == "synthetic-otp-token"
        )
        assert minted == [(user.uid, {"emailAuthMethod": "otp"})]
    else:
        with pytest.raises(EmailAuthError):
            FirebaseEmailIdentity().issue(user.uid, "person@example.com")
        assert minted == []


@pytest.mark.asyncio
async def test_delivery_checks_revocation_and_kill_switch_before_mail_api(
    store, config, monkeypatch
):
    service = EmailAuthService(config, store, Evaluator(), Identity())
    _, row, _ = await challenge(service)
    sent = []

    class Transport:
        async def send(self, *args):
            sent.append(args)

    worker = EmailAuthDeliveryWorker(service, Transport())
    monkeypatch.setenv("EMAIL_AUTH_ENABLED", "false")
    assert not await worker.deliver_one()
    assert not sent
    monkeypatch.setenv("EMAIL_AUTH_ENABLED", "true")
    await store.revoke_domain(row["domain"])
    assert not await worker.deliver_one()
    assert not sent


@pytest.mark.asyncio
async def test_revocation_serializes_with_an_in_flight_submission(store, config):
    service = EmailAuthService(config, store, Evaluator(), Identity())
    _, row, _ = await challenge(service)
    entered = asyncio.Event()
    release = asyncio.Event()

    class Transport:
        async def send(self, *args):
            entered.set()
            await release.wait()

    send = asyncio.create_task(EmailAuthDeliveryWorker(service, Transport()).deliver_one())
    await asyncio.wait_for(entered.wait(), timeout=2)
    revoke = asyncio.create_task(store.revoke_domain(row["domain"]))
    await asyncio.sleep(0.05)
    assert not revoke.done()
    release.set()
    assert await send is True
    await revoke
    assert (await store.challenge(row["challenge_id"]))["cancelled_at"] is not None


@pytest.mark.asyncio
async def test_production_router_keeps_domain_rejection_account_independent(
    store, config, monkeypatch
):
    from api.routes import email_auth

    service = EmailAuthService(config, store, Evaluator(), Identity())
    monkeypatch.setattr(email_auth, "_service", service)
    app = FastAPI()
    app.include_router(email_auth.router)
    await store.revoke_domain("example.com")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://local"
    ) as client:
        for address in ["existing@example.com", "unknown@example.com"]:
            result = await client.post(
                "/api/auth/email/request",
                json={
                    "email": address,
                    "browser_binding": secrets.token_urlsafe(32),
                    "request_key": secrets.token_urlsafe(24),
                },
            )
            assert result.status_code == 403
            assert result.json()["error"] == "email_domain_not_approved"
    assert await store.pool.fetchval("SELECT COUNT(*) FROM email_auth_challenges") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["consume", "lease"])
async def test_expiry_is_rechecked_after_waiting_for_challenge_lock(
    store, config, monkeypatch, operation
):
    service = EmailAuthService(config, store, Evaluator(), Identity())
    binding, row, code = await challenge(service)
    admitted = asyncio.Event()
    authority = {}
    original_admit = store._admit

    async def expiring_admission(conn, domain, risk_version):
        await original_admit(conn, domain, risk_version)
        # Start the short deadline only after actual admission, on the same
        # transaction that owns the domain lock. Scheduling cannot refresh it.
        decision = await conn.fetchrow(
            "UPDATE email_auth_domain_decisions SET expires_at=clock_timestamp()+INTERVAL '0.2 seconds' WHERE domain=$1 RETURNING *",
            domain,
        )
        authority["pid"] = await conn.fetchval("SELECT pg_backend_pid()")
        authority["expiry"] = decision["expires_at"]
        admitted.set()
        return decision

    monkeypatch.setattr(store, "_admit", expiring_admission)
    async with store.pool.acquire() as blocker, blocker.transaction():
        blocker_pid = await blocker.fetchval("SELECT pg_backend_pid()")
        await blocker.fetchrow(
            "SELECT * FROM email_auth_challenges WHERE challenge_id=$1 FOR UPDATE",
            row["challenge_id"],
        )
        task = asyncio.create_task(
            store.consume(
                row["challenge_id"],
                service._digest("browser", binding),
                service._digest(
                    "code",
                    row["challenge_id"],
                    row["destination_hash"],
                    row["expires_at"].isoformat(),
                    code,
                ),
                "fixture",
            )
            if operation == "consume"
            else store.lease_delivery(row, "lease-fixture", "fixture")
        )
        try:
            await asyncio.wait_for(admitted.wait(), 3)

            async def wait_for_row_lock():
                while not await store.pool.fetchval(
                    "SELECT $1=ANY(pg_blocking_pids($2))", blocker_pid, authority["pid"]
                ):
                    await asyncio.sleep(0.005)

            await asyncio.wait_for(wait_for_row_lock(), 3)
            await store.pool.execute("SELECT pg_sleep_until($1)", authority["expiry"])
            assert await store.pool.fetchval("SELECT clock_timestamp()>=$1", authority["expiry"])
        except BaseException:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            raise
    with pytest.raises(EmailAuthError):
        await task
    final = await store.challenge(row["challenge_id"])
    assert final["consumed_at"] is None and final["delivery_lease_id"] is None


@pytest.mark.asyncio
async def test_expired_secrets_are_erased_with_issuance_disabled(store, config, monkeypatch):
    from hushh_mcp.services.email_auth.delivery import run_retention

    service = EmailAuthService(config, store, Evaluator(), Identity())
    _, row, _ = await challenge(service)
    await store.pool.execute(
        "UPDATE email_auth_challenges SET expires_at=clock_timestamp()-INTERVAL '1 second'"
    )
    monkeypatch.setenv("EMAIL_AUTH_ENABLED", "false")
    monkeypatch.delenv("EMAIL_AUTH_PAYLOAD_KEY")

    async def factory():
        return store

    async def end_after_sweep(_):
        raise asyncio.CancelledError()

    monkeypatch.setattr("hushh_mcp.services.email_auth.delivery.asyncio.sleep", end_after_sweep)
    with pytest.raises(asyncio.CancelledError):
        await run_retention(factory)
    retained = await store.challenge(row["challenge_id"])
    assert retained["payload"] is None and retained["destination_ciphertext"] is None


@pytest.mark.asyncio
async def test_exhausted_code_cannot_be_recovered_by_correct_guess(store, config):
    service = EmailAuthService(config, store, Evaluator(), Identity())
    binding, row, code = await challenge(service)
    wrong = "000000" if code != "000000" else "000001"
    for _ in range(5):
        with pytest.raises(EmailAuthError):
            await service.verify(row["challenge_id"], wrong, binding)
    with pytest.raises(EmailAuthError):
        await service.verify(row["challenge_id"], code, binding)
    assert (await store.challenge(row["challenge_id"]))["attempts"] == 5


@pytest.mark.asyncio
async def test_verified_mailbox_can_reconcile_a_provisional_identity_reservation(store, config):
    identity = Identity()
    identity.users["person@example.com"] = SimpleNamespace(uid="provider-winner")
    service = EmailAuthService(config, store, Evaluator(), identity)
    binding, row, code = await challenge(service)
    await store.reserve_new_identity(row["destination_hash"], "unused-reservation")
    proof = await service.verify(row["challenge_id"], code, binding)
    assert proof["status"] == "authenticated"
    assert identity.enrollment_calls == 0
    assert await store.enrollment(row["destination_hash"]) == "provider-winner"


def test_deleted_reserved_uid_is_rejected_before_firebase_creation(monkeypatch):
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )
    from hushh_mcp.services.email_auth.identity import FirebaseEmailIdentity

    created = []

    class Missing(Exception):
        pass

    def get_user(*args, **kwargs):
        raise Missing()

    def create_user(**kwargs):
        created.append(kwargs["uid"])
        return SimpleNamespace(
            uid=kwargs["uid"], email=kwargs["email"], disabled=False, custom_claims={}
        )

    auth = SimpleNamespace(get_user=get_user, create_user=create_user, UserNotFoundError=Missing)
    monkeypatch.setattr(FirebaseEmailIdentity, "_context", staticmethod(lambda: (auth, object())))
    monkeypatch.setattr(
        AccountDeletionLifecycleService, "is_tombstoned", staticmethod(lambda uid: True)
    )
    with pytest.raises(EmailAuthError):
        FirebaseEmailIdentity().provision("deleted-owner", "person@example.com")
    assert not created


@pytest.mark.asyncio
async def test_api_validation_never_reflects_credentials(store, config, monkeypatch):
    from api.routes import email_auth

    monkeypatch.setattr(
        email_auth, "_service", EmailAuthService(config, store, Evaluator(), Identity())
    )
    app = FastAPI()
    app.include_router(email_auth.router)
    secret = secrets.token_urlsafe(32)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://local"
    ) as client:
        result = await client.post(
            "/api/auth/email/verify",
            json={"challenge_id": secret, "code": "secret-code", "browser_binding": secret},
        )
        assert result.status_code == 400
        assert secret not in result.text and "secret-code" not in result.text
        result = await client.post("/api/auth/email/request", content="x" * 3000)
        assert result.status_code == 413
