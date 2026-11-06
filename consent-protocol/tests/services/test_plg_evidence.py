"""Security boundary of the server-only pilot projection; no live information."""

import asyncio
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only
from api.routes.one import plg
from hushh_mcp.hushh_adk import product_activity as sdk
from hushh_mcp.services import marketing_preferences
from hushh_mcp.services import plg_audience as audience
from hushh_mcp.services import plg_customer_cohort as cohort
from hushh_mcp.services import plg_evidence as evidence
from hushh_mcp.services import plg_outcomes as outcomes
from hushh_mcp.services import plg_reporting as reporting
from hushh_mcp.services import product_activity as sink
from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id
from hushh_mcp.services.plg_catalog import activity_catalog

SECRET = "test-only-plg-export-signature-key-with-32-characters"
NOW = datetime.now(timezone.utc)
ACCOUNT = {"accountId": "pilot-account", "journey": "memory", "since": NOW.isoformat()}
PLAN = "pkm_plan_abcdefghijkl"
COMMIT = derive_pkm_mutation_commit_id(
    user_id=ACCOUNT["accountId"], domain="home_projects", plan_id=PLAN
)


def test_attempt_email_choice_is_owner_bound_manual_and_separate(monkeypatch):
    from hushh_mcp.services import attempt_email as emails

    app = FastAPI()
    app.include_router(plg.router)
    with TestClient(app) as caller:
        url = "/api/one/plg/attempt-email/preferences"
        body = {"enabled": True, "expectedRevision": 0, "disclosureVersion": emails.DISCLOSURE}
        assert caller.get(url).status_code == 401
        assert caller.put(url, json=body).status_code == 401
        app.dependency_overrides[require_firebase_auth_read_only] = lambda: "authenticated-owner"
        read = AsyncMock(return_value={"enabled": False, "revision": 0, "available": True})
        write = AsyncMock(return_value={"enabled": True, "revision": 1})
        revoke = AsyncMock()
        monkeypatch.setattr(emails, "preference", read)
        monkeypatch.setattr(emails, "choose", write)
        monkeypatch.setattr(emails, "unsubscribe", revoke)
        result = caller.get(url)
        assert result.status_code == 200 and "no-store" in result.headers["cache-control"]
        write.assert_not_called()
        for invalid in (
            {**body, "accountId": "other"},
            {**body, "email": "other@example.invalid"},
            {**body, "enabled": "true"},
            {**body, "expectedRevision": True},
            {**body, "disclosureVersion": "one-email-updates-v1"},
        ):
            assert caller.put(url, json=invalid).status_code == 422
        write.assert_not_called()
        assert caller.put(url, json=body).status_code == 200
        assert write.await_args.args == ("authenticated-owner",)
        # Link scanners only see a manual confirmation; RFC8058 requires POST.
        assert caller.get("/api/one/plg/attempt-email/unsubscribe?token=fixture").status_code == 200
        revoke.assert_not_called()
        assert (
            caller.post(
                "/api/one/plg/attempt-email/unsubscribe?token=fixture",
                content="List-Unsubscribe=One-Click",
            ).status_code
            == 200
        )
        revoke.assert_awaited_once_with("fixture")


def test_attempt_worker_requires_distinct_key_project_lane_purpose_and_closed_body(
    client, monkeypatch
):
    from hushh_mcp.services import attempt_email as emails
    from hushh_mcp.services import attempt_email_feedback as feedback

    key = "test-only-attempt-worker-separate-secret-with-32-characters"
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_ACCOUNT_IDS", "owner")
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_SECRET", key)
    pending = AsyncMock(return_value=[])
    claim = AsyncMock(return_value=None)
    monkeypatch.setattr(emails, "pending", pending)
    monkeypatch.setattr(emails, "claim", claim)
    monkeypatch.setattr(
        feedback,
        "read",
        AsyncMock(return_value={"oldestAt": None, "unsettled": False, "unbound": []}),
    )
    apply_feedback = AsyncMock(return_value=True)
    monkeypatch.setattr(feedback, "apply", apply_feedback)

    def call(action="pull", purpose="attempt-emails.production.pull", secret=key, body=None):
        raw = json.dumps(body or {}, separators=(",", ":"))
        at = str(int(time.time() * 1000))
        signature = hmac.new(
            secret.encode(), f"{purpose}\n{at}\n{raw}".encode(), hashlib.sha256
        ).hexdigest()
        return client.post(
            f"/api/one/plg/attempt-email/{action}",
            content=raw,
            headers={
                "Content-Type": "application/json",
                "X-PLG-Timestamp": at,
                "X-PLG-Signature": signature,
            },
        )

    assert call(secret=SECRET).status_code == 401
    assert call(purpose="snapshot").status_code == 401
    assert call(purpose="attempt-emails.uat.pull").status_code == 401
    pending.assert_not_called()
    assert call().json() == {"environment": "production", "deliveries": []}
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert call(purpose="attempt-emails.uat.pull").status_code == 404
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_UAT_ENABLED", "true")
    monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", raising=False)
    assert call().status_code == 401
    assert call(purpose="attempt-emails.uat.pull").status_code == 200
    body = {"id": str(uuid.uuid4()), "claimId": str(uuid.uuid4()), "accountId": "owner"}
    for field in ("to", "bcc", "text", "subject"):
        assert (
            call("claim", "attempt-emails.uat.claim", body={**body, field: "untrusted"}).status_code
            == 400
        )
    claim.assert_not_called()
    assert call("claim", "attempt-emails.uat.claim", body=body).status_code == 200
    assert claim.await_args.args[0] == "owner"
    monkeypatch.setenv("ONE_PLG_UAT_EXPORT_SECRET", key)
    assert call(purpose="attempt-emails.uat.pull").status_code == 404
    monkeypatch.delenv("ONE_PLG_UAT_EXPORT_SECRET")
    monkeypatch.setenv("ONE_PLG_AUDIENCE_SECRET", key)
    assert call(purpose="attempt-emails.uat.pull").status_code == 404
    monkeypatch.delenv("ONE_PLG_AUDIENCE_SECRET")
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_ACCOUNT_IDS", "")
    assert call(purpose="attempt-emails.uat.pull").status_code == 200
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_ENABLED", "false")
    assert call(purpose="attempt-emails.uat.pull").status_code == 404
    # Stopping enrollment does not discard acknowledgements or bounce evidence.
    ack = AsyncMock(return_value=True)
    monkeypatch.setattr(emails, "acknowledge", ack)
    receipt = {"id": body["id"], "claimId": body["claimId"], "providerId": "accepted_fixture"}
    assert call("settle", "attempt-emails.production.settle", body=receipt).status_code == 401
    for extra in ({"accountId": "other"}, {"to": "untrusted"}, {"notSubmitted": True}):
        assert (
            call("settle", "attempt-emails.uat.settle", body={**receipt, **extra}).status_code
            == 400
        )
    ack.assert_not_awaited()
    assert call("settle", "attempt-emails.uat.settle", body=receipt).json()["received"] is True
    assert ack.await_args.args == (
        uuid.UUID(body["id"]),
        uuid.UUID(body["claimId"]),
        "accepted_fixture",
    )
    assert call("feedback-state", "attempt-emails.uat.feedback-state").status_code == 200
    assert call("feedback-state", "attempt-emails.production.feedback-state").status_code == 401
    facts = {"submissions": [], "bounces": []}
    assert (
        call(
            "feedback-apply",
            "attempt-emails.uat.feedback-apply",
            body={**facts, "bcc": "untrusted"},
        ).status_code
        == 400
    )
    assert (
        call(
            "feedback-apply",
            "attempt-emails.uat.feedback-apply",
            body={**facts, "bounces": [{"messageId": "bad\r\nheader", "recipientHash": "f" * 64}]},
        ).status_code
        == 400
    )
    apply_feedback.assert_not_called()
    assert call("feedback-apply", "attempt-emails.uat.feedback-apply", body=facts).json()[
        "complete"
    ]
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_ACCOUNT_IDS", "owner")
    monkeypatch.setenv("ONE_PLG_ATTEMPT_EMAIL_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-dev")
    # A historical Dev revision labelled UAT cannot borrow UAT authority.
    assert call(purpose="attempt-emails.uat.pull").status_code == 404
    monkeypatch.setenv("ENVIRONMENT", "dev")
    assert call(purpose="attempt-emails.uat.pull").status_code == 401
    assert call(purpose="attempt-emails.dev.pull").json() == {
        "environment": "dev",
        "deliveries": [],
    }
    monkeypatch.setenv("ONE_PLG_DEV_EXPORT_SECRET", key)
    assert call(purpose="attempt-emails.dev.pull").status_code == 404


@pytest.mark.parametrize("uid", ["owner.with+custom@example.test", "private/owner", "a" * 128])
def test_snapshot_accepts_the_same_bounded_firebase_uid_as_subscription_enrollment(uid):
    request = evidence.PilotRequest(accounts=[{**ACCOUNT, "accountId": uid}])
    assert request.accounts[0].accountId == uid


@pytest.mark.parametrize("uid", ["", "a" * 129, 17])
def test_snapshot_uid_still_rejects_empty_overlong_and_non_string_identity(uid):
    with pytest.raises(ValueError):
        evidence.PilotRequest(accounts=[{**ACCOUNT, "accountId": uid}])


@pytest.fixture
def reporting_roster(monkeypatch):
    monkeypatch.setenv(
        "ONE_PLG_REPORTING_POLICY_JSON",
        json.dumps(
            {
                "version": 1,
                "excludedAccountIds": [],
                "excludedEmails": ["staff@example.test"],
                "excludedDomains": ["company.example"],
            }
        ),
    )
    monkeypatch.setenv("REVIEWER_UID", "reviewer")
    monkeypatch.setenv("REVIEWER_COUNTERPART_UID", "reviewer-counterpart")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_INNER_TEAM_EMAILS", "inner@example.test")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_SENIOR_TEAM_EMAILS", "")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_QA_EMAILS", "qa@example.test")


def test_reporting_policy_requires_production_identity_and_explicit_internal_evidence(
    reporting_roster, monkeypatch
):
    policy = reporting.reporting_policy()
    identity = {"email": "customer@example.test", "display_name": "John Smith"}
    assert policy.eligible("customer", identity)  # A name alone never excludes a customer.
    assert policy.eligible("customer", {"email": "customer@company.example.evil.test"})
    assert policy.eligible("phone", {"phone_verified": True, "phone_number": "+919876543210"})
    assert not policy.eligible("auth-only", None)
    assert not policy.eligible("anonymous", {"phone_number": "+919876543210"})
    assert not policy.eligible("reviewer", identity)
    assert not policy.eligible("reviewer-counterpart", identity)
    for alias in (
        " STAFF@example.test ",
        "inner@example.test",
        "qa@example.test",
        "person@company.example",
        "person@sub.company.example",
    ):
        assert not policy.eligible("customer", identity, [alias])
    assert len(policy.revision) == 64 and "staff" not in json.dumps(policy.proof())
    monkeypatch.delenv("ONE_PLG_REPORTING_POLICY_JSON")
    with pytest.raises(reporting.ReportingPolicyUnavailable, match="policy unavailable"):
        reporting.reporting_policy()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ONE_PLG_EXPORT_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_EXPORT_SECRET", SECRET)
    monkeypatch.setenv("ONE_PLG_EXPORT_ACCOUNT_IDS", ACCOUNT["accountId"])
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    app = FastAPI()
    app.include_router(plg.router)
    with TestClient(app) as value:
        yield value


@pytest.mark.asyncio
async def test_current_reporting_identifiers_are_bounded_read_only_and_production_only(monkeypatch):
    from firebase_admin import auth

    from api.utils import firebase_admin

    record = SimpleNamespace(
        uid="customer",
        disabled=False,
        custom_claims={},
        email="customer@example.test",
        phone_number=None,
        provider_data=[SimpleNamespace(email="staff@company.example")],
        password_hash="PRIVATE_AUTH_EXPORT",  # noqa: S106 - synthetic export-leak sentinel
    )
    calls = []
    monkeypatch.setattr(
        firebase_admin, "get_firebase_auth_app", lambda: SimpleNamespace(project_id="hushh-pda")
    )
    monkeypatch.setattr(
        auth,
        "get_users",
        lambda identifiers, **kwargs: (
            calls.append(identifiers) or SimpleNamespace(users=[record], not_found=[])
        ),
    )
    result = await reporting.current_reporting_identifiers(["customer", "customer"])
    assert result == {"customer": ("customer@example.test", "staff@company.example")}
    assert len(calls) == 1 and len(calls[0]) == 1
    assert "PRIVATE_AUTH_EXPORT" not in json.dumps(result)
    record.disabled = True
    assert await reporting.current_reporting_identifiers(["customer"]) == {}
    monkeypatch.setattr(auth, "get_users", lambda *a, **k: SimpleNamespace(users=[], not_found=[]))
    with pytest.raises(ValueError, match="Invalid customer reporting identities"):
        await reporting.current_reporting_identifiers(["customer"])
    monkeypatch.setattr(
        auth,
        "get_users",
        lambda *a, **k: SimpleNamespace(users=[], not_found=[auth.UidIdentifier("customer")]),
    )
    assert await reporting.current_reporting_identifiers(["customer"]) == {}
    monkeypatch.setattr(
        firebase_admin, "get_firebase_auth_app", lambda: SimpleNamespace(project_id="hushh-uat")
    )
    with pytest.raises(ValueError, match="source unavailable"):
        await reporting.current_reporting_identifiers(["customer"])
    with pytest.raises(ValueError, match="bound exceeded"):
        await reporting.current_reporting_identifiers([f"account-{n}" for n in range(51)])
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_marketing_permission_requires_current_auth_authority_verified_recipient(monkeypatch):
    from firebase_admin import auth

    from api.utils import firebase_admin as identity

    app = object()
    person = SimpleNamespace(
        email=" Current@Example.invalid ",
        email_verified=True,
        disabled=False,
        display_name="Fixture",
        user_metadata=SimpleNamespace(creation_timestamp=1_700_000_000_000),
    )
    read = MagicMock(return_value=person)
    monkeypatch.setattr(identity, "get_firebase_auth_app", lambda: app)
    monkeypatch.setattr(auth, "get_user", read)
    result = await marketing_preferences.verified_recipient("authenticated-owner")
    read.assert_called_once_with("authenticated-owner", app=app)
    assert result["email"] == "current@example.invalid"
    assert result["email_hash"] == hashlib.sha256(b"current@example.invalid").hexdigest()
    person.email_verified = False
    with pytest.raises(marketing_preferences.VerifiedEmailRequired):
        await marketing_preferences.verified_recipient("authenticated-owner")
    read.side_effect = auth.UserNotFoundError("Synthetic missing recipient")
    with pytest.raises(marketing_preferences.VerifiedEmailRequired):
        await marketing_preferences.verified_recipient("authenticated-owner")


def post(client, payload=None, purpose="snapshot", secret=SECRET, version=None, route="snapshot"):
    body = json.dumps({"accounts": [ACCOUNT]} if payload is None else payload)
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(
        secret.encode(), f"{purpose}\n{timestamp}\n{body}".encode(), hashlib.sha256
    ).hexdigest()
    return client.post(
        f"/api/one/plg/{route}",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-PLG-Timestamp": timestamp,
            "X-PLG-Signature": signature,
            **({"X-PLG-Version": str(version)} if version is not None else {}),
        },
    )


def test_production_own_activity_requires_separate_identity_authority_not_marketing(
    client, monkeypatch
):
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    key = "own-fixture-key-" * 3
    monkeypatch.setenv("ONE_PLG_OWNER_EXPORT_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_OWNER_EXPORT_SECRET", key)
    monkeypatch.setenv("ONE_PLG_OWNER_ACCOUNT_IDS", ACCOUNT["accountId"])
    monkeypatch.setattr(
        marketing_preferences,
        "current_permission",
        AsyncMock(side_effect=AssertionError("marketing must not authorize own reads")),
    )
    owner = AsyncMock(return_value={"environment": "production", "accountId": ACCOUNT["accountId"]})
    monkeypatch.setattr(plg, "session_owner_scope", owner)
    epoch = "b" * 64
    authority = AsyncMock(return_value={"allowed": True, "erased": False, "ownerEpoch": epoch})
    monkeypatch.setattr(plg, "owner_read_authority", authority)
    projection = AsyncMock(
        return_value={
            "environment": "production",
            "accounts": [{"deleted": False, "activity": {"epoch": epoch}}],
        }
    )
    monkeypatch.setattr(plg, "snapshot", projection)

    def call(route="owner", purpose="owner.production.owner", payload=None, secret=key):
        return post(
            client,
            payload=payload or {"emailHash": "a" * 64},
            route=route,
            purpose=purpose,
            secret=secret,
        )

    assert call(purpose="owner-uat").status_code == 401
    assert call(secret=SECRET).status_code == 401
    assert call(payload={"emailHash": "a" * 64, "accountId": "override"}).status_code == 400
    assert not owner.called
    assert call().json()["deliveryAuthorized"] is False
    assert owner.await_args.kwargs == {"environment": "production"}
    scoped = {**ACCOUNT, "emailHash": "a" * 64, "ownerEpoch": epoch}
    payload = {"version": 2, "customerReporting": False, "accounts": [scoped]}
    assert call("snapshot-owner", "owner.production.snapshot", payload).status_code == 200
    assert projection.await_args.kwargs == {"environment": "production"}
    assert projection.await_args.args[0].customerReporting is False
    assert (
        call(
            "snapshot-owner", "owner.production.snapshot", {**payload, "customerReporting": True}
        ).status_code
        == 400
    )
    authority.side_effect = [
        {"allowed": True, "erased": False, "ownerEpoch": epoch},
        {"allowed": False, "erased": False, "ownerEpoch": None},
    ]
    assert call("snapshot-owner", "owner.production.snapshot", payload).status_code == 400
    for other_key in (SECRET, "u" * 40):
        monkeypatch.setenv("ONE_PLG_UAT_EXPORT_SECRET", "u" * 40)
        monkeypatch.setenv("ONE_PLG_OWNER_EXPORT_SECRET", other_key)
        assert call(secret=other_key).status_code == 404
    monkeypatch.setenv("ONE_PLG_OWNER_EXPORT_SECRET", key)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert call().status_code == 404
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert call().status_code == 404


@pytest.mark.parametrize("environment", ["uat", "dev"])
def test_uat_snapshot_is_separately_signed_scoped_and_never_customer_reporting(
    client, monkeypatch, environment
):
    uat_secret = "u" * 40
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", f"hushh-pda-{environment}")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "true")
    monkeypatch.setenv(f"ONE_PLG_ACTIVITY_{environment.upper()}_ENABLED", "true")
    monkeypatch.setenv(f"ONE_PLG_{environment.upper()}_EXPORT_ENABLED", "true")
    monkeypatch.setenv(f"ONE_PLG_{environment.upper()}_EXPORT_SECRET", uat_secret)
    monkeypatch.setenv(f"ONE_PLG_ACTIVITY_{environment.upper()}_ACCOUNT_IDS", ACCOUNT["accountId"])
    monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", raising=False)
    epoch = "e" * 64
    authority = AsyncMock(return_value={"allowed": True, "erased": False, "ownerEpoch": epoch})
    monkeypatch.setattr(plg, "owner_read_authority", authority)
    projection = AsyncMock(
        return_value={
            "environment": environment,
            "accounts": [{"deleted": False, "activity": {"epoch": epoch}}],
        }
    )
    monkeypatch.setattr(plg, "snapshot", projection)
    scoped_account = {
        **ACCOUNT,
        "emailHash": "a" * 64,
        "ownerEpoch": epoch,
    }
    payload = {"version": 2, "customerReporting": False, "accounts": [scoped_account]}

    def call(**kw):
        return post(
            client, payload=kw.pop("payload", payload), route=f"snapshot-{environment}", **kw
        )

    assert call(purpose="snapshot", secret=uat_secret).status_code == 401
    assert call(purpose=f"snapshot-{environment}", secret=uat_secret).status_code == 200
    assert projection.await_args.kwargs == {"environment": environment}
    permission_request = {
        key: scoped_account[key] for key in ("accountId", "emailHash", "ownerEpoch")
    }
    permission_response = post(
        client,
        payload=permission_request,
        purpose=f"permission-{environment}",
        secret=uat_secret,
        route=f"permission-{environment}",
    )
    assert permission_response.status_code == 200
    assert permission_response.json() == {
        "environment": environment,
        "deliveryAuthorized": False,
        "allowed": True,
        "erased": False,
        "ownerEpoch": epoch,
    }
    assert (
        post(
            client,
            payload=permission_request,
            purpose=f"snapshot-{environment}",
            secret=uat_secret,
            route=f"permission-{environment}",
        ).status_code
        == 401
    )
    owner_scope = AsyncMock(
        return_value={"environment": environment, "accountId": ACCOUNT["accountId"]}
    )
    monkeypatch.setattr(plg, "session_owner_scope", owner_scope)
    monkeypatch.setenv(
        f"ONE_PLG_ACTIVITY_{environment.upper()}_ACCOUNT_IDS", ACCOUNT["accountId"] + ",team-owner"
    )
    assert (
        post(
            client,
            payload={},
            purpose=f"snapshot-{environment}",
            secret=uat_secret,
            route=f"owner-{environment}",
        ).status_code
        == 401
    )
    owner_response = post(
        client,
        payload={"emailHash": "a" * 64},
        purpose=f"owner-{environment}",
        secret=uat_secret,
        route=f"owner-{environment}",
    )
    assert owner_response.status_code == 200
    assert owner_response.json()["deliveryAuthorized"] is False
    cohort = None if environment == "uat" else {ACCOUNT["accountId"], "team-owner"}
    assert owner_scope.await_args.args[:2] == (cohort, "a" * 64)
    assert (
        post(
            client,
            payload={},
            purpose=f"owner-{environment}",
            secret=uat_secret,
            route=f"owner-{environment}",
        ).status_code
        == 400
    )
    assert (
        post(
            client,
            payload={"accountId": "other"},
            purpose=f"owner-{environment}",
            secret=uat_secret,
            route=f"owner-{environment}",
        ).status_code
        == 400
    )
    assert (
        call(
            purpose=f"snapshot-{environment}",
            secret=uat_secret,
            payload={**payload, "customerReporting": True},
        ).status_code
        == 400
    )
    # A valid signature cannot substitute for this owner's current authority.
    authority.return_value = {"allowed": False, "erased": False, "ownerEpoch": None}
    projection.reset_mock()
    assert (
        call(
            purpose=f"snapshot-{environment}",
            secret=uat_secret,
            payload={**payload, "accounts": [{**scoped_account, "accountId": "other"}]},
        ).status_code
        == 400
    )
    projection.assert_not_awaited()
    authority.return_value = {"allowed": True, "erased": False, "ownerEpoch": epoch}
    if environment == "uat":
        monkeypatch.delenv("ONE_PLG_ACTIVITY_UAT_ACCOUNT_IDS")
        assert call(purpose="snapshot-uat", secret=uat_secret).status_code == 200
        assert projection.await_args.args[1] == {ACCOUNT["accountId"]}
    authority.side_effect = [
        {"allowed": True, "erased": False, "ownerEpoch": epoch},
        {"allowed": False, "erased": False, "ownerEpoch": None},
    ]
    assert call(purpose=f"snapshot-{environment}", secret=uat_secret).status_code == 400
    authority.side_effect = [
        {"allowed": True, "erased": False, "ownerEpoch": epoch},
        {"allowed": True, "erased": False, "ownerEpoch": "f" * 64},
    ]
    assert call(purpose=f"snapshot-{environment}", secret=uat_secret).status_code == 400
    authority.side_effect = None
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    assert call(purpose=f"snapshot-{environment}", secret=uat_secret).status_code == 404
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", f"hushh-pda-{environment}")
    monkeypatch.setenv("ONE_PLG_EXPORT_SECRET", uat_secret)
    assert call(purpose=f"snapshot-{environment}", secret=uat_secret).status_code == 404


@pytest.mark.asyncio
async def test_uat_team_resolution_rejects_ambiguous_stale_or_unenrolled_owner(monkeypatch):
    email_hash = hashlib.sha256(b"tester@hushh.ai").hexdigest()
    rows = [{"user_id": "owner-b", "email": "Tester@hushh.ai"}]

    class Connection:
        def transaction(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def fetch(self, sql, users, **_kwargs):
            assert users == ["owner-b"]  # inactive owner-a is excluded before lookup
            assert "actor_identity_cache" in sql and "marketing" not in sql
            return rows

    class Pool:
        def acquire(self, **_kwargs):
            return Connection()

    monkeypatch.setattr(evidence, "get_pool", AsyncMock(return_value=Pool()))
    monkeypatch.setattr(
        evidence.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value={"owner-b"}),
    )
    current = AsyncMock(return_value={"accountId": "owner-b", "emailHash": email_hash})
    monkeypatch.setattr(evidence, "owner_scope", current)

    def resolve():
        return evidence.session_owner_scope({"owner-a", "owner-b"}, email_hash, NOW)

    assert (await resolve())["accountId"] == "owner-b"
    current.assert_awaited_once_with("owner-b", NOW, environment="uat")
    current.return_value = {"accountId": "owner-b", "emailHash": "c" * 64}
    assert await resolve() is None
    current.return_value = None  # revoked while the candidate was being resolved
    assert await resolve() is None
    current.reset_mock()
    for candidates in (
        [],
        [{"user_id": "owner-b", "email": "tester@hushh.ai"}] * 2,
        [{"user_id": "outside", "email": "tester@hushh.ai"}],
    ):
        rows[:] = candidates
        assert await resolve() is None
    current.assert_not_awaited()
    barrier = evidence.AccountDeletionLifecycleService.active_projection_user_ids
    barrier.reset_mock()
    await evidence.session_owner_scope({f"owner-{i:03}" for i in range(100)}, email_hash, NOW)
    assert [len(call.kwargs["user_ids"]) for call in barrier.await_args_list] == [50, 50]


@pytest.mark.asyncio
async def test_registered_uat_session_lookup_rechecks_current_owner_and_rejects_ambiguity(
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_UAT_ENABLED", "true")
    monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", raising=False)
    email_hash = hashlib.sha256(b"member@hushhtech.com").hexdigest()
    rows = [{"user_id": "not-in-a-tester-list"}]

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def fetch(self, sql, requested_hash, **kwargs):
            assert requested_hash == email_hash and kwargs["timeout"] == 5
            assert "LIMIT 2" in sql and "SELECT user_id FROM actor_identity_cache" in sql
            return rows

    class Pool:
        def acquire(self, **_):
            return Connection()

    pool = AsyncMock(return_value=Pool())
    current = AsyncMock(return_value={"accountId": rows[0]["user_id"], "emailHash": email_hash})
    monkeypatch.setattr(evidence, "get_pool", pool)
    monkeypatch.setattr(evidence, "owner_scope", current)
    assert (await evidence.session_owner_scope(None, email_hash, NOW))["accountId"] == rows[0][
        "user_id"
    ]
    current.assert_awaited_once_with(rows[0]["user_id"], NOW, environment="uat")
    for unavailable in (None, {"accountId": rows[0]["user_id"], "emailHash": "a" * 64}):
        current.return_value = unavailable
        assert await evidence.session_owner_scope(None, email_hash, NOW) is None
    current.reset_mock()
    rows.append({"user_id": "same-email-alias"})
    assert await evidence.session_owner_scope(None, email_hash, NOW) is None
    rows.clear()
    assert await evidence.session_owner_scope(None, email_hash, NOW) is None
    current.assert_not_awaited()
    pool.reset_mock()
    for environment in ("dev", "production"):
        with pytest.raises(ValueError):
            await evidence.session_owner_scope(None, email_hash, NOW, environment=environment)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    with pytest.raises(ValueError):
        await evidence.session_owner_scope(None, email_hash, NOW)
    pool.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("environment", ["dev", "uat", "production"])
async def test_owner_scope_requires_verified_identity_and_epoch_not_marketing(
    monkeypatch, environment
):
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    epoch = uuid.UUID("abcdefab-1234-1234-1234-123456789abc")
    row = {
        "generation": epoch,
        "started_at": NOW - timedelta(hours=1),
    }

    class Connection:
        def transaction(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def fetchrow(self, sql, *_args, **_kwargs):
            assert "one_product_activity_epochs" in sql and "marketing" not in sql
            return dict(row)

    class Pool:
        def acquire(self, **_kwargs):
            return Connection()

    monkeypatch.setattr(evidence, "get_pool", AsyncMock(return_value=Pool()))
    monkeypatch.setattr(evidence, "enabled_for", lambda _: True)
    monkeypatch.setattr(
        evidence.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value={"owner"}),
    )
    recipient = AsyncMock(return_value={"email_hash": "a" * 64})
    monkeypatch.setattr(marketing_preferences, "verified_recipient", recipient)
    marketing = AsyncMock(side_effect=AssertionError("Own reads must not require marketing"))
    monkeypatch.setattr(marketing_preferences, "current_permission", marketing)
    result = await evidence.owner_scope("owner", NOW, environment=environment)
    assert result == {
        "environment": environment,
        "readAuthority": "verified_owner",
        "accountId": "owner",
        "emailHash": "a" * 64,
        "ownerEpoch": hashlib.sha256(str(epoch).encode()).hexdigest(),
        "since": row["started_at"].isoformat(),
        "journey": "agent_one",
    }
    marketing.assert_not_awaited()
    recipient.side_effect = marketing_preferences.VerifiedEmailRequired("unverified")
    assert await evidence.owner_scope("owner", NOW, environment=environment) is None

    async def reset_during_identity(_uid):
        row["generation"] = uuid.uuid4()
        return {"email_hash": "a" * 64}

    recipient.side_effect = reset_during_identity
    assert await evidence.owner_scope("owner", NOW, environment=environment) is None
    recipient.reset_mock()
    monkeypatch.setattr(evidence, "enabled_for", lambda _: False)
    assert await evidence.owner_scope("owner", NOW, environment=environment) is None
    recipient.assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_read_authority_binds_current_recipient_and_owner_epoch(monkeypatch):
    scope = AsyncMock(return_value={"emailHash": "a" * 64, "ownerEpoch": "b" * 64})
    monkeypatch.setattr(evidence, "owner_scope", scope)
    result = await evidence.owner_read_authority("owner", "a" * 64, "b" * 64)
    assert result == {
        "allowed": True,
        "erased": False,
        "ownerEpoch": "b" * 64,
    }
    for changed in (
        None,
        {"emailHash": "c" * 64, "ownerEpoch": "b" * 64},
        {"emailHash": "a" * 64, "ownerEpoch": "c" * 64},
    ):
        scope.return_value = changed
        assert not (await evidence.owner_read_authority("owner", "a" * 64, "b" * 64))["allowed"]


@pytest.mark.asyncio
async def test_uat_snapshot_never_emits_production_reporting_proof():
    result = await evidence.snapshot(
        evidence.PilotRequest(version=2, accounts=[]), set(), NOW, environment="uat"
    )
    assert result["environment"] == "uat" and "customerReporting" not in result
    with pytest.raises(ValueError):
        await evidence.snapshot(
            evidence.PilotRequest(version=2, accounts=[], customerReporting=True),
            set(),
            NOW,
            environment="uat",
        )


def test_optional_email_preference_uses_only_authenticated_owner(monkeypatch):
    app = FastAPI()
    app.include_router(plg.router)
    client = TestClient(app)
    body = {
        "enabled": True,
        "frequency": "weekly",
        "expectedRevision": 0,
        "disclosureVersion": "one-email-updates-v1",
        "surface": "setup",
    }
    assert client.get("/api/one/plg/preferences").status_code == 401
    assert client.put("/api/one/plg/preferences", json=body).status_code == 401
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "authenticated-owner"
    read = AsyncMock(return_value={"enabled": False, "revision": 0})
    write = AsyncMock(return_value={"enabled": True, "revision": 1})
    monkeypatch.setattr(marketing_preferences, "preference", read)
    monkeypatch.setattr(marketing_preferences, "choose_preference", write)
    result = client.get("/api/one/plg/preferences")
    assert result.status_code == 200 and "no-store" in result.headers["cache-control"]
    write.assert_not_called()
    for invalid in [
        {**body, "accountId": "other"},
        {**body, "email": "other@example.test"},
        {**body, "enabled": "true"},
        {**body, "expectedRevision": True},
    ]:
        assert client.put("/api/one/plg/preferences", json=invalid).status_code == 422
    write.assert_not_called()
    assert client.put("/api/one/plg/preferences", json=body).status_code == 200
    assert write.call_args.args == ("authenticated-owner",)
    assert write.call_args.kwargs["expected_revision"] == 0


def test_subscription_key_and_purpose_cannot_grant_other_authority(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_SUBSCRIPTION_ENABLED", "true")
    key = "test-only-separate-subscription-integration-key"
    monkeypatch.setenv("ONE_PLG_SUBSCRIPTION_SECRET", key)
    source = AsyncMock(return_value={"version": 1, "environment": "production", "changes": []})
    monkeypatch.setattr(marketing_preferences, "pending_changes", source)

    def pull(purpose, secret):
        timestamp = str(int(time.time() * 1000))
        signature = hmac.new(
            secret.encode(), f"{purpose}\n{timestamp}\n{{}}".encode(), hashlib.sha256
        ).hexdigest()
        return client.post(
            "/api/one/plg/subscriptions/pull",
            content="{}",
            headers={
                "Content-Type": "application/json",
                "X-PLG-Timestamp": timestamp,
                "X-PLG-Signature": signature,
            },
        )

    assert pull("snapshot", key).status_code == 401
    assert pull("subscriptions.pull", SECRET).status_code == 401
    source.assert_not_called()
    assert pull("subscriptions.pull", key).status_code == 200
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert pull("subscriptions.pull", key).status_code == 404
    assert source.await_count == 1


def test_snapshot_adds_only_recorded_permission_cohort(client, monkeypatch):
    monkeypatch.delenv("ONE_PLG_EXPORT_ACCOUNT_IDS", raising=False)
    assert post(client).status_code == 404
    monkeypatch.setenv("ONE_PLG_SUBSCRIPTION_ENABLED", "true")
    admitted = AsyncMock(return_value={ACCOUNT["accountId"]})
    projection = AsyncMock(return_value={"version": 1, "accounts": []})
    monkeypatch.setattr(marketing_preferences, "permitted_snapshot_accounts", admitted)
    monkeypatch.setattr(plg, "snapshot", projection)
    assert post(client).status_code == 200
    assert projection.call_args.args[1] == {ACCOUNT["accountId"]}
    admitted.assert_awaited_once_with([ACCOUNT["accountId"]])
    monkeypatch.setattr(plg, "snapshot", evidence.snapshot)
    admitted.return_value = set()
    assert post(client).status_code == 400


def test_export_rejects_wrong_signature_purpose_and_nonproduction(client, monkeypatch):
    source = AsyncMock(return_value={"version": 1})
    monkeypatch.setattr(plg, "snapshot", source)
    assert post(client, secret=SECRET + "-tampered").status_code == 401
    assert post(client, purpose="events").status_code == 401
    assert not source.called
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    assert post(client).status_code == 404
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert post(client).status_code == 404
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    assert (
        post(client).status_code == 200
    )  # Negative control: correct authority reaches the source.
    assert source.call_count == 1
    assert source.call_args.args[0].version == 1
    assert post(client, version=2).status_code == 200
    assert source.call_args.args[0].version == 2


def test_customer_cohort_route_has_distinct_read_authority(client, monkeypatch):
    monkeypatch.setenv("ONE_PLG_AUDIENCE_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_AUDIENCE_SECRET", SECRET)
    source = AsyncMock(return_value={"version": 1})
    monkeypatch.setattr(plg, "customer_cohort_page", source)
    assert (
        post(client, {"cursor": None}, purpose="audience", route="customer-cohort").status_code
        == 401
    )
    assert not source.called
    assert (
        post(
            client, {"cursor": None}, purpose="customer-cohort", route="customer-cohort"
        ).status_code
        == 200
    )
    source.side_effect = cohort.CohortCursorError("private cursor details")
    assert (
        post(
            client, {"cursor": "bad"}, purpose="customer-cohort", route="customer-cohort"
        ).status_code
        == 400
    )
    source.side_effect = reporting.ReportingPolicyUnavailable("private config details")
    failed = post(client, {"cursor": None}, purpose="customer-cohort", route="customer-cohort")
    assert failed.status_code == 503 and "private config" not in failed.text
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert (
        post(
            client, {"cursor": None}, purpose="customer-cohort", route="customer-cohort"
        ).status_code
        == 404
    )
    assert source.call_count == 3


@pytest.mark.asyncio
async def test_customer_cohort_excludes_internal_aliases_and_tombstones_without_private_exports(
    monkeypatch, reporting_roster
):
    # Simulate database collation order that differs from Python lexical order.
    ids = ["company", "customer", "alias", "deleted", "missing", "provider", "staff"]
    registered = (NOW - timedelta(days=30)).isoformat()
    connection = SimpleNamespace(execute=AsyncMock())
    connection.fetch = AsyncMock(return_value=[{"user_id": uid} for uid in ids])

    class Lease:
        async def __aenter__(self):
            return connection

        async def __aexit__(self, *_):
            pass

    connection.transaction = lambda **_: Lease()
    monkeypatch.setattr(
        cohort, "get_pool", AsyncMock(return_value=SimpleNamespace(acquire=lambda **_: Lease()))
    )
    monkeypatch.setattr(
        cohort.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value=set(ids) - {"deleted"}),
    )
    identities = {uid: {"email": uid + "@example.test"} for uid in ids}
    identities["company"] = {"email": "person@company.example"}
    monkeypatch.setattr(cohort.ActorIdentityService, "get_many", AsyncMock(return_value=identities))
    monkeypatch.setattr(
        cohort.ActorIdentityService,
        "get_many_verified_email_aliases",
        AsyncMock(return_value={"alias": ["staff@example.test"]}),
    )
    current = {
        uid: {"emails": (uid + "@example.test",), "registeredAt": registered}
        for uid in ids
        if uid != "missing"
    }
    current["provider"]["emails"] = ("external@example.test", "person@company.example")
    monkeypatch.setattr(cohort, "current_reporting_records", AsyncMock(return_value=current))
    result = await cohort.customer_cohort_page(cohort.CohortRequest(), SECRET, NOW)
    assert result["rows"] == [
        {"analyticsUserId": "abfd2046757cddb0c5d965b012287279", "registeredAt": registered}
    ]
    assert result["scanned"] == 7 and result["excluded"] == 6 and result["nextCursor"] is None
    assert "@" not in json.dumps(result) and "deleted" not in json.dumps(result)
    sql, last, at = connection.fetch.call_args.args
    assert (
        'COLLATE "C"' not in sql and "ORDER BY user_id LIMIT 51" in sql and last == "" and at == NOW
    )
    # Continuation hides even the last denied UID and binds the policy and window.
    revision = reporting.reporting_policy().revision
    cursor = cohort._cipher(SECRET).seal(
        json.dumps(
            {"last": "private-denied-uid", "asOf": NOW.isoformat(), "policyRevision": revision}
        ),
        cohort.PURPOSE,
    )
    assert "private-denied-uid" not in cursor
    assert cohort._cursor(cursor, SECRET, revision, NOW) == ("private-denied-uid", NOW)
    for key, version, now in [
        (SECRET + "bad", revision, NOW),
        (SECRET, "a" * 64, NOW),
        (SECRET, revision, NOW + timedelta(minutes=10)),
    ]:
        with pytest.raises(ValueError, match="Invalid customer cohort cursor"):
            cohort._cursor(cursor, key, version, now)


def test_validation_and_provider_errors_never_echo_identifiers_or_private_details(
    client, monkeypatch
):
    result = post(client, {"accounts": [{**ACCOUNT, "accountId": "private/invalid-uid"}]})
    assert result.status_code == 400
    assert "private/invalid-uid" not in result.text
    monkeypatch.setattr(plg, "snapshot", AsyncMock(side_effect=RuntimeError("PRIVATE_DB_CONTENT")))
    result = post(client)
    assert result.status_code == 503
    assert "PRIVATE_DB_CONTENT" not in result.text
    assert result.headers["cache-control"] == "private, no-store"
    monkeypatch.setattr(plg, "snapshot", evidence.snapshot)
    monkeypatch.setenv("ONE_PLG_REPORTING_POLICY_JSON", "malformed")
    result = post(client, {"accounts": [], "version": 2, "customerReporting": True})
    assert result.status_code == 503 and "malformed" not in result.text


@pytest.mark.asyncio
async def test_projection_bounds_owner_and_window_and_carries_deletion_without_content(
    monkeypatch, reporting_roster
):
    class Connection:
        execute = AsyncMock()

        def transaction(self, **_):
            return Acquire()

        async def fetch(self, query, *args, **kwargs):
            assert args == (ACCOUNT["accountId"], NOW, NOW)
            if (
                "FROM pkm_domain_commits" not in query
                and "FROM gmail_owner_send_actions" not in query
            ):
                return []
            return [
                {
                    "action_id": COMMIT,
                    "occurred_at": NOW,
                    "private_content": "PRIVATE_CONTENT",
                    "domain": "home_projects",
                    "plan_id": PLAN,
                    "authorization_mode": "owner_confirmed",
                }
            ]

        async def fetchval(self, *_args, **_kwargs):
            return False

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_):
            pass

    class Pool:
        def acquire(self, **kwargs):
            return Acquire()

    monkeypatch.setattr(evidence, "get_pool", AsyncMock(return_value=Pool()))
    monkeypatch.setattr(
        evidence.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value={ACCOUNT["accountId"]}),
    )
    request = evidence.PilotRequest.model_validate({"accounts": [ACCOUNT]})
    result = await evidence.snapshot(request, {ACCOUNT["accountId"]}, NOW)
    assert result["retainedOnly"] is True
    assert len(result["accounts"][0]["tasks"]) == 1
    assert "PRIVATE_CONTENT" not in json.dumps(result)
    assert "committed-action" not in json.dumps(result)
    assert COMMIT not in json.dumps(result)
    monkeypatch.setattr(evidence, "enabled_for", lambda _: False)
    expanded = await evidence.snapshot(
        request.model_copy(update={"version": 2}), {ACCOUNT["accountId"]}, NOW
    )
    account = expanded["accounts"][0]
    assert account["tasks"] == []
    assert {row["agentId"] for row in account["verified"]} == {
        "agent_personal_information",
        "agent_email",
        "agent_one",
    }
    assert account["activity"]["enabled"] is False
    assert "PRIVATE_CONTENT" not in json.dumps(expanded)
    identity = {ACCOUNT["accountId"]: {"email": "staff@example.test"}}
    monkeypatch.setattr(evidence.ActorIdentityService, "get_many", AsyncMock(return_value=identity))
    monkeypatch.setattr(
        evidence,
        "current_reporting_identifiers",
        AsyncMock(return_value={ACCOUNT["accountId"]: ("customer@example.test",)}),
    )
    monkeypatch.setattr(
        evidence.ActorIdentityService, "get_many_verified_email_aliases", AsyncMock(return_value={})
    )
    customer_result = await evidence.snapshot(
        request.model_copy(update={"customerReporting": True}), {ACCOUNT["accountId"]}, NOW
    )
    assert customer_result["customerReporting"]["scope"] == "production_registered_contacts"
    assert customer_result["accounts"][0]["reportingEligible"] is False
    assert customer_result["accounts"][0]["deleted"] is False
    assert customer_result["accounts"][0]["tasks"] == []  # Exclusion never asserts deletion.
    identity[ACCOUNT["accountId"]]["email"] = "customer@example.test"
    customer_result = await evidence.snapshot(
        request.model_copy(update={"customerReporting": True}), {ACCOUNT["accountId"]}, NOW
    )
    assert customer_result["accounts"][0]["reportingEligible"] is True
    assert len(customer_result["accounts"][0]["tasks"]) == 1
    for identifiers in (
        {ACCOUNT["accountId"]: ("customer@example.test", "provider@company.example")},
        {},
    ):
        monkeypatch.setattr(
            evidence, "current_reporting_identifiers", AsyncMock(return_value=identifiers)
        )
        customer_result = await evidence.snapshot(
            request.model_copy(update={"customerReporting": True}), {ACCOUNT["accountId"]}, NOW
        )
        assert customer_result["accounts"][0]["reportingEligible"] is False
        assert customer_result["accounts"][0]["tasks"] == []
    with pytest.raises(ValueError):
        await evidence.snapshot(request, {"another-owner"}, NOW)
    monkeypatch.setattr(
        evidence.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value=set()),
    )
    result = await evidence.snapshot(request, {ACCOUNT["accountId"]}, NOW)
    assert result["accounts"][0]["deleted"] is True
    assert result["accounts"][0]["tasks"] == []


def test_memory_requires_exact_plan_commit_and_explicit_owner_confirmation():
    row = {
        "action_id": COMMIT,
        "domain": "home_projects",
        "plan_id": PLAN,
        "authorization_mode": "owner_confirmed",
    }
    assert evidence.confirmed_memory(row, ACCOUNT["accountId"])
    assert not evidence.confirmed_memory(
        {**row, "authorization_mode": "owner_auto_save_policy"}, ACCOUNT["accountId"]
    )
    assert not evidence.confirmed_memory(
        {**row, "plan_id": "pkm_another_plan_abcdefghijkl"}, ACCOUNT["accountId"]
    )
    assert not evidence.confirmed_memory(row, "different-owner")


def test_observation_api_derives_owner_and_source_and_rejects_payloads(client, monkeypatch):
    from api.middleware import require_firebase_auth_read_only

    client.app.dependency_overrides[require_firebase_auth_read_only] = lambda: "verified-owner"
    monkeypatch.setattr(sink, "enabled_for", lambda uid: uid == "verified-owner")
    observe = sink.observe
    calls = []
    monkeypatch.setattr(sink, "observe", lambda *args: calls.append(args) or True)
    body = {
        "generation": "12345678-1234-1234-1234-123456789012",
        "operationId": "test-operation-1234",
        "actionId": "observation:one_memory_action:detail_edited",
        "phase": "returned",
    }
    for field in (
        {"userId": "other-owner"},
        {"source": "execution_observed"},
        {"prompt": "PRIVATE"},
    ):
        response = client.post("/api/one/plg/activity", json={**body, **field})
        assert response.status_code == 400
        assert "PRIVATE" not in response.text
    assert not calls
    assert client.post("/api/one/plg/activity", json=body).status_code == 200
    assert calls[0][0] == "verified-owner"
    assert calls[0][4] == "client_reported"
    with pytest.raises(ValueError):
        observe(
            "verified-owner",
            body["generation"],
            "agent:agent_one",
            "returned",
            "client_reported",
            body["operationId"],
        )


def test_catalog_covers_authored_agents_and_actions_without_dynamic_tool_names():
    import json

    from hushh_mcp.services.generated_contracts import generated_contract_path
    from hushh_mcp.services.plg_catalog import runtime_descriptor

    catalog = activity_catalog()
    registry = json.loads(
        generated_contract_path("agents", "product-agent-registry.v2.json").read_text()
    )
    graph = json.loads(generated_contract_path("kai", "one-capability-graph.v1.json").read_text())
    assert {a["id"] for a in catalog["agents"]} == {a["id"] for a in registry["agents"]}
    assert {a["capability_id"] for a in graph["actions"]} <= {a["id"] for a in catalog["actions"]}
    assert {a["agentId"] for a in catalog["actions"]} <= {a["id"] for a in catalog["agents"]}
    assert set(outcomes.DEFINITIONS) <= {a["id"] for a in catalog["agents"] if a["public"]}
    assert all(
        a["outcome"]["status"]
        == (
            "internal"
            if not a["public"]
            else "supported"
            if a["id"] in outcomes.DEFINITIONS
            else "unmeasured"
        )
        for a in catalog["agents"]
    )
    gateway = json.loads(
        generated_contract_path("kai", "kai-action-gateway.vnext.json").read_text()
    )
    assert {a["action_id"] for a in gateway["actions"]} <= {a["id"] for a in catalog["actions"]}
    document_actions = [a for a in catalog["actions"] if a["id"].startswith("document.")]
    assert document_actions
    assert all(a["agentId"] == "agent_documents" for a in document_actions)
    chat = [a for a in catalog["actions"] if a["id"].startswith("chat:")]
    assert {a["agentId"] for a in chat} == {
        "agent_one",
        "agent_email",
        "agent_location",
        "agent_personal_information",
        "agent_kai",
    }
    assert all(a["proof"] == "client_reported" and a["kind"] == "action" for a in chat)
    private = runtime_descriptor("agent_one", "PRIVATE_CUSTOMER_MCP_TOOL")
    assert private["id"] == "runtime-tool:agent_one"
    assert "PRIVATE_CUSTOMER" not in json.dumps(private)


@pytest.mark.asyncio
async def test_owner_snapshot_catalog_uses_its_environment_without_cross_lane_cache():
    request = evidence.PilotRequest(version=2, accounts=[])

    async def availability(environment):
        result = await evidence.snapshot(request, set(), NOW, environment=environment)
        return {agent["id"]: agent["available"] for agent in result["catalog"]["agents"]}

    production = await availability("production")
    uat = await availability("uat")
    dev = await availability("dev")
    assert uat["agent_documents"] is True
    assert production["agent_documents"] is False
    assert dev["agent_files"] is True
    assert uat["agent_files"] is False
    for lane in (production, uat, dev):
        assert lane["agent_one"] is True
        assert lane["agent_career"] is False
        assert lane["agent_memory_merge"] is False
    assert await availability("production") == production
    with pytest.raises(ValueError, match="Invalid activity catalog environment"):
        activity_catalog("untrusted-lane")


def test_sdk_session_uid_alone_never_establishes_admission(monkeypatch):
    monkeypatch.setattr(sink, "enabled_for", lambda _: True)
    monkeypatch.setattr(sdk.HushhContext, "current", lambda: None)
    context = SimpleNamespace(user_id="owner", state={})
    assert sdk._owner(context) is None
    context.state = {"temp:hussh:workspace_chat_admission": True, "hussh:user_id": "another-owner"}
    assert sdk._owner(context) is None
    context.state["hussh:user_id"] = "owner"
    assert sdk._owner(context) == "owner"


@pytest.mark.asyncio
async def test_sdk_pins_epoch_across_sibling_tasks_and_drops_unadmitted_or_finished_runs(
    monkeypatch,
):
    epoch = ["old-epoch"]
    monkeypatch.setattr(sdk, "_owner", lambda _: "owner")
    monkeypatch.setattr(sink, "enabled_for", lambda _: True)
    admitted = []
    monkeypatch.setattr(
        sink, "admission", lambda uid: admitted.append(uid) or {"generation": epoch[0]}
    )
    observations = []
    monkeypatch.setattr(sink, "observe", lambda *args: observations.append(args))
    plugin = sdk.ProductActivityPlugin("agent_one")
    run = SimpleNamespace(
        user_id="owner",
        invocation_id="invocation",
        session=SimpleNamespace(state={}),
        agent=SimpleNamespace(name="agent_one"),
    )
    context = SimpleNamespace(
        user_id="owner",
        agent_name="agent_one",
        invocation_id="invocation",
        function_call_id="call",
        state={},
    )
    tool = SimpleNamespace(name="PRIVATE_DYNAMIC_TOOL")
    assert (
        await plugin.after_tool_callback(
            tool=tool, tool_args={"private": "PRIVATE"}, tool_context=context, result="PRIVATE"
        )
        is None
    )
    assert observations == []
    assert await plugin.before_run_callback(invocation_context=run) is None
    epoch[0] = "new-epoch"
    assert (
        await asyncio.create_task(
            plugin.after_tool_callback(
                tool=tool, tool_args={"private": "PRIVATE"}, tool_context=context, result="PRIVATE"
            )
        )
        is None
    )
    assert observations[0][1] == "old-epoch"
    assert observations[0][2] == "runtime-tool:agent_one"
    assert "PRIVATE" not in repr(observations)
    assert admitted == ["owner"]
    # Model errors may be recovered by the SDK. Only an error escaping the
    # runner supplies failed-run evidence, under the original owner/epoch.
    await plugin.on_model_error_callback(
        callback_context=context, llm_request="PRIVATE", error=RuntimeError("PRIVATE")
    )
    assert len(observations) == 1
    assert (
        await plugin.on_run_error_callback(invocation_context=run, error=RuntimeError("PRIVATE"))
        is None
    )
    assert observations[1][1:5] == ("old-epoch", "agent:agent_one", "failed", "execution_observed")
    assert "PRIVATE" not in repr(observations)
    await plugin.after_run_callback(invocation_context=run)
    await plugin.after_agent_callback(
        agent=SimpleNamespace(parent_agent=None), callback_context=context
    )
    assert len(observations) == 2


@pytest.mark.asyncio
async def test_v2_catalog_bootstrap_never_opens_database_and_activity_never_becomes_tasks(
    monkeypatch,
):
    monkeypatch.setattr(
        evidence, "get_pool", AsyncMock(side_effect=AssertionError("no DB on bootstrap"))
    )
    result = await evidence.snapshot(
        evidence.PilotRequest(version=2, accounts=[]), {ACCOUNT["accountId"]}, NOW
    )
    assert result["accounts"] == []
    assert result["catalog"]["agents"]
    with pytest.raises(ValueError):
        await evidence.snapshot(evidence.PilotRequest(accounts=[]), {ACCOUNT["accountId"]}, NOW)
    monkeypatch.setattr(evidence, "enabled_for", lambda _: True)
    connection = SimpleNamespace(
        fetchrow=AsyncMock(return_value={"generation": "private-epoch", "started_at": NOW}),
        fetch=AsyncMock(
            return_value=[
                {
                    "agent_id": "agent_calendar",
                    "action_id": "retired.action",
                    "source": "client_reported",
                }
            ]
        ),
        fetchval=AsyncMock(return_value=False),
    )
    observed = await evidence.activity_snapshot(connection, evidence.PilotAccount(**ACCOUNT), NOW)
    assert observed["limited"] is True
    assert observed["rollups"] == []
    assert "private-epoch" not in json.dumps(observed)


def test_audience_requires_separate_purpose_key_production_and_activation(client, monkeypatch):
    key = SECRET + "-audience"
    source = AsyncMock(return_value={"rows": []})
    monkeypatch.setattr(plg, "audience_page", source)
    monkeypatch.setenv("ONE_PLG_AUDIENCE_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_AUDIENCE_SECRET", key)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")

    def call(**kwargs):
        return post(client, {"agentId": "agent_one"}, route="audience", **kwargs)

    assert call(purpose="audience").status_code == 401
    assert call(purpose="snapshot", secret=key).status_code == 401
    assert not source.called
    assert call(purpose="audience", secret=key).status_code == 200
    assert source.call_count == 1
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert call(purpose="audience", secret=key).status_code == 404
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_AUDIENCE_ENABLED", "false")
    assert call(purpose="audience", secret=key).status_code == 404
    monkeypatch.setenv("ONE_PLG_AUDIENCE_ENABLED", "true")
    source.side_effect = RuntimeError("PRIVATE_EMAIL_AND_PHONE")
    response = call(purpose="audience", secret=key)
    assert response.status_code == 503
    assert "PRIVATE_EMAIL" not in response.text
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.asyncio
async def test_audience_search_filters_current_identity_before_loading_activity(monkeypatch):
    eligible = {
        uid: SimpleNamespace(
            uid=uid,
            display_name="Target old alias",
            email="target-old@example.test",
            email_verified=True,
            provider_data=[],
        )
        for uid in ("match", "cleared-alias", "inactive")
    }
    identities = {
        "match": {"display_name": "Target Member", "email": "member@example.test"},
        "cleared-alias": {"display_name": None, "email": None},
        "inactive": {"display_name": "Target Inactive"},
    }
    conn = SimpleNamespace(fetch=AsyncMock(return_value=[]))
    summaries = AsyncMock(return_value={"match": {"count": 0}})
    monkeypatch.setattr(audience, "value_summaries", summaries)
    request = audience.AudienceRequest(query=" TARGET ")
    rows = await audience._audience_rows(
        conn, eligible, {"match", "cleared-alias"}, identities, {}, request, NOW
    )
    assert [row["accountId"] for row in rows] == ["match"]
    assert all(call.args[1] == ["match"] for call in conn.fetch.await_args_list)
    assert summaries.await_args.args[1] == ["match"]
    conn.fetch.reset_mock()
    summaries.reset_mock()
    assert (
        await audience._audience_rows(
            conn,
            eligible,
            {"match", "cleared-alias"},
            identities,
            {},
            request.model_copy(update={"query": "no match"}),
            NOW,
        )
        == []
    )
    conn.fetch.assert_not_awaited()
    summaries.assert_not_awaited()


def test_audience_cursor_binds_filters_window_project_and_signature():
    request = audience.AudienceRequest(agentId="agent_one", query="Test", graceMinutes=60)
    cursor = audience._next_cursor("provider-page", request, SECRET, NOW)
    following = request.model_copy(update={"cursor": cursor})
    assert audience._cursor(following, SECRET, NOW) == ("provider-page", NOW)
    for changed in (
        following.model_copy(update={"query": "different"}),
        following.model_copy(update={"segment": "failed"}),
        following.model_copy(update={"graceMinutes": 15}),
        following.model_copy(update={"cursor": cursor + "a"}),
    ):
        with pytest.raises(audience.AudienceCursorError):
            audience._cursor(changed, SECRET, NOW)
    with pytest.raises(audience.AudienceCursorError):
        audience._cursor(following, SECRET, NOW + timedelta(minutes=16))


def test_audience_canonical_clears_win_and_provider_identity_is_bounded_and_whitelisted():
    record = SimpleNamespace(
        uid="phone-only",
        disabled=False,
        custom_claims={},
        provider_data=[],
        email=None,
        email_verified=False,
        phone_number="+919876543210",
        display_name="N" * 300,
        **{"password_hash": "PRIVATE_HASH", "password_salt": "PRIVATE_SALT"},
    )
    assert audience._registered(record)
    fallback = audience._identity(record, None, record.phone_number)
    assert fallback["phoneNumber"] == "+919876543210"
    assert len(fallback["name"]) == 160
    canonical = audience._identity(
        record,
        {"display_name": "Saved", "email": None, "phone_number": None, "phone_verified": False},
        record.phone_number,
    )
    assert canonical["source"] == "canonical"
    assert canonical["phoneNumber"] is None and canonical["email"] is None
    assert "PRIVATE" not in json.dumps([fallback, canonical])
    record.disabled = True
    assert not audience._registered(record)
    record.disabled = False
    record.phone_number = None
    assert not audience._registered(
        record
    )  # Anonymous/unclassified never becomes a registered lead.


def test_attempt_summary_pairs_each_invocation_and_labels_missing_terminals_as_uncertain():
    started = NOW - timedelta(hours=2)

    def row(
        operation, terminal=None, at=NOW, action="agent:agent_one", source="execution_observed"
    ):
        return {
            "action_id": action,
            "source": source,
            "operation_key": operation,
            "started_at": started if operation == "a" else None,
            "last_at": at,
            "terminal": terminal,
            "terminal_at": at if terminal else None,
            "observations": 1,
        }

    rows = [row("a", at=started), row("b", "returned"), row(None, "returned")]
    options = dict(
        agent_id="agent_one",
        now=NOW,
        grace=60,
        epoch={"started_at": started},
        limited=False,
        enabled=True,
    )
    result = audience.summarize_attempts(rows, **options)
    assert result["counts"]["possibleIncomplete"] == 1
    assert result["counts"]["returned"] == 1
    assert result["counts"]["uncorrelated"] == 1
    rows[0] = row("a", "returned")  # A late terminal closes only its own invocation.
    result = audience.summarize_attempts(rows, **options)
    assert result["counts"]["possibleIncomplete"] == 0
    assert result["counts"]["returned"] == 2
    hidden = audience.summarize_attempts(rows, **{**options, "enabled": False, "limited": True})
    assert hidden["coverage"] == "unavailable"
    assert not any(hidden["counts"].values())
    assert hidden["lastObservedAt"] is None and hidden["collectionStartedAt"] is None
    assert not audience._matches(
        {"identity": {}, "activity": hidden}, audience.AudienceRequest(segment="returned")
    )


@pytest.mark.parametrize(
    ("phase", "field"), [("returned", "lastReturnedAt"), ("failed", "lastFailureAt")]
)
def test_terminal_receipt_time_is_not_replaced_by_a_later_start(phase, field):
    terminal_at = NOW - timedelta(minutes=2)
    rows = [
        {
            "action_id": "agent:agent_one",
            "source": "execution_observed",
            "operation_key": "reordered-call",
            "started_at": NOW,
            "last_at": NOW,
            "terminal": phase,
            "terminal_at": terminal_at,
            "observations": 2,
        }
    ]
    result = audience.summarize_attempts(
        rows,
        agent_id="agent_one",
        now=NOW,
        grace=60,
        epoch={"started_at": NOW - timedelta(hours=1)},
        limited=False,
        enabled=True,
    )
    assert result[field] == terminal_at.isoformat()
    assert result["lastObservedAt"] == NOW.isoformat()
    assert result["counts"][phase] == 1
    assert result["counts"]["possibleIncomplete"] == 0


@pytest.mark.asyncio
async def test_phone_fallback_claim_lock_rejects_a_number_bound_to_another_owner():
    conn = SimpleNamespace(
        execute=AsyncMock(),
        fetch=AsyncMock(return_value=[{"user_id": "new-owner", "phone_number": "+919876543210"}]),
    )
    result = await audience.ActorIdentityService.read_provider_phone_fallbacks(
        conn,
        candidates={"old-owner": "+919876543210", "new-owner": "+919876543210", "bad": "98765"},
    )
    assert result == {"new-owner": "+919876543210"}
    assert "hashtextextended($1, 0)" in conn.execute.call_args.args[0]
    assert conn.execute.call_args.args[1] == "actor_identity_phone_claim:+919876543210"


@pytest.mark.asyncio
async def test_audience_projection_excludes_tombstoned_owner_after_canonical_barriers():
    from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash

    conn = SimpleNamespace(execute=AsyncMock(), fetch=AsyncMock())

    async def tombstones(query, hashes, **_):
        # Any deletion that was already in flight must commit before this read.
        assert [call.args[1:] for call in conn.execute.call_args_list] == [
            ("active", 171),
            ("retired", 171),
            ("active", 198),
            ("retired", 198),
        ]
        assert "account_deletion_tombstones" in query
        assert account_deletion_user_hash("retired") in hashes
        return [{"user_id_hash": account_deletion_user_hash("retired")}]

    conn.fetch.side_effect = tombstones
    active = await audience.AccountDeletionLifecycleService.active_projection_user_ids(
        conn, user_ids=["retired", "active", "active"]
    )
    assert active == {"active"}
    with pytest.raises(ValueError, match="bound"):
        await audience.AccountDeletionLifecycleService.active_projection_user_ids(
            conn, user_ids=[str(n) for n in range(51)]
        )
    assert conn.fetch.call_count == 1


@pytest.mark.asyncio
async def test_audience_live_page_excludes_deleted_accounts_and_never_serializes_provider_records(
    monkeypatch,
    reporting_roster,
):
    records = [
        SimpleNamespace(
            uid=uid,
            disabled=False,
            custom_claims={},
            provider_data=[],
            email=None,
            email_verified=False,
            phone_number="+919876543210",
            display_name="Phone only",
            **{"password_hash": "PRIVATE_HASH"},
        )
        for uid in ("active", "deleted", "staff", "alias", "auth-only", "reviewer")
    ]
    monkeypatch.setattr(
        audience,
        "_firebase_page",
        lambda _: SimpleNamespace(users=records, **{"next_page_token": "next"}),
    )

    class Context:
        def __init__(self, value):
            self.value = value

        async def __aenter__(self):
            return self.value

        async def __aexit__(self, *_):
            pass

    conn = SimpleNamespace(
        execute=AsyncMock(),
        fetch=AsyncMock(return_value=[]),
        fetchval=AsyncMock(return_value=False),
    )

    async def source_page(query, *args, **_):
        if "owners.user_id AS _plg_user_id" in query:
            assert args[0] == ["active"]  # Tombstoned identities never reach the outcome query.
            if "AS capped" in query:
                return [{"_plg_user_id": "active", "capped": False}]
        return []

    conn.fetch.side_effect = source_page
    conn.transaction = lambda **_: Context(None)
    monkeypatch.setattr(
        audience,
        "get_pool",
        AsyncMock(return_value=SimpleNamespace(acquire=lambda **_: Context(conn))),
    )
    monkeypatch.setattr(
        audience.AccountDeletionLifecycleService,
        "active_projection_user_ids",
        AsyncMock(return_value={"active", "staff", "alias", "auth-only", "reviewer"}),
    )
    monkeypatch.setattr(
        audience.ActorIdentityService,
        "get_many",
        AsyncMock(
            return_value={
                "active": {
                    "display_name": "John Smith",
                    "phone_verified": True,
                    "phone_number": "+919876543210",
                },
                "staff": {"email": "person@company.example"},
                "alias": {"email": "customer@example.test"},
                "reviewer": {"email": "customer@example.test"},
            }
        ),
    )
    monkeypatch.setattr(
        audience.ActorIdentityService,
        "get_many_verified_email_aliases",
        AsyncMock(return_value={"alias": ["staff@example.test"]}),
    )
    monkeypatch.setattr(
        audience.ActorIdentityService,
        "read_provider_phone_fallbacks",
        AsyncMock(return_value={"active": "+919876543210"}),
    )
    monkeypatch.setattr(audience, "enabled_for", lambda _: False)
    result = await audience.audience_page(audience.AudienceRequest(), SECRET, NOW)
    assert result["scanned"] == 6 and result["excluded"] == 5
    assert result["customerReporting"]["scope"] == "production_registered_contacts"
    assert [r["accountId"] for r in result["rows"]] == ["active"]
    assert result["rows"][0]["identity"]["phoneNumber"] == "+919876543210"
    assert result["rows"][0]["verified"]["supported"] is True
    assert result["rows"][0]["verified"]["count"] == 0
    assert "PRIVATE_HASH" not in json.dumps(result)
    assert result["campaignEnrollmentChanged"] is False and result["nextCursor"]


def test_all_registered_collection_remains_explicit_and_production_only(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "true")
    monkeypatch.setenv("ONE_PLG_EXPORT_ACCOUNT_IDS", "pilot-account")
    monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", raising=False)
    assert sink.enabled_for("pilot-account") and not sink.enabled_for("new-account")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", "true")
    assert sink.enabled_for("new-account")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    assert not sink.enabled_for("new-account")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "false")
    assert not sink.enabled_for("new-account")


@pytest.mark.parametrize("environment", ["uat", "dev"])
def test_uat_activity_admits_registered_users_but_dev_keeps_its_cohort(monkeypatch, environment):
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("APP_RUNTIME_PROFILE", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", f"hushh-pda-{environment}")
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ENABLED", "true")
    monkeypatch.setenv(f"ONE_PLG_ACTIVITY_{environment.upper()}_ACCOUNT_IDS", "uat-owner")
    monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", raising=False)
    monkeypatch.delenv(f"ONE_PLG_ACTIVITY_{environment.upper()}_ENABLED", raising=False)
    assert not sink.enabled_for("uat-owner")
    monkeypatch.setenv(f"ONE_PLG_ACTIVITY_{environment.upper()}_ENABLED", "true")
    assert sink.enabled_for("uat-owner")
    assert sink.enabled_for("other-owner") is (environment == "uat")
    if environment == "uat":
        monkeypatch.delenv("ONE_PLG_ACTIVITY_UAT_ACCOUNT_IDS")
        assert sink.enabled_for("other-owner")
        identity = MagicMock()
        identity.execute.return_value.scalar.return_value = False
        assert not sink._registered_profile(identity, "anonymous-owner")
        identity.execute.return_value.scalar.return_value = True
        assert sink._registered_profile(identity, "other-owner")
        assert not sink.enabled_for("") and not sink.enabled_for("x" * 129)
    monkeypatch.setenv("ONE_PLG_ACTIVITY_ALL_REGISTERED", "true")
    assert not sink.enabled_for("uat-owner")
    monkeypatch.delenv("ONE_PLG_ACTIVITY_ALL_REGISTERED")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    assert not sink.enabled_for("uat-owner")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", f"hushh-pda-{environment}")
    monkeypatch.setenv("ENVIRONMENT", "uat" if environment == "dev" else "dev")
    assert not sink.enabled_for("uat-owner")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("ONE_PLG_EXPORT_ACCOUNT_IDS", raising=False)
    assert not sink.enabled_for("uat-owner")


@pytest.mark.asyncio
async def test_domain_outcomes_classify_saved_artifacts_and_deduplicate_shared_one_effects():
    uid = ACCOUNT["accountId"]
    commits = []
    for domain, writer in [
        ("financial", "kai_analysis_completion"),
        ("professional", "career_resume_owner_review"),
        ("wallet", "wallet_card_owner_review"),
        ("home_projects", "memory_owner_review"),
    ]:
        commits.append(
            {
                "action_id": derive_pkm_mutation_commit_id(
                    user_id=uid, domain=domain, plan_id=PLAN
                ),
                "occurred_at": NOW,
                "domain": domain,
                "plan_id": PLAN,
                "authorization_mode": "owner_confirmed",
                "writer_id": writer,
            }
        )
    # Incorrect provenance and a plan/commit mismatch must not count even with a positive SDK return.
    invalid = [
        {**commits[0], "authorization_mode": "owner_auto_save_policy"},
        {**commits[0], "action_id": "unbound-commit"},
    ]
    fixtures = {
        outcomes.MEMORY_SQL.replace("LIMIT 101", "LIMIT 1001"): commits + invalid,
        outcomes.WALLET_SQL: [{"action_id": commits[2]["action_id"]}],
        outcomes.MAIL_SQL.replace("LIMIT 101", "LIMIT 1001"): [
            {"action_id": "mail-effect", "occurred_at": NOW}
        ],
        outcomes.KYC_SQL: [{"action_id": "mail-effect", "occurred_at": NOW}],
        **{
            sql: [{"action_id": name, "occurred_at": NOW}]
            for name, sql in [
                ("calendar", outcomes.CALENDAR_SQL),
                ("nav", outcomes.NAV_SQL),
                ("location-command", outcomes.LOCATION_SQL),
                ("location-direct", outcomes.LOCATION_DIRECT_SQL),
                ("document", outcomes.DOCUMENTS_SQL),
                ("crm", outcomes.CRM_SQL),
            ]
        },
    }
    calls = []

    async def fetch(query, *args, **_):
        assert args == (uid, NOW, NOW)
        calls.append(query)
        return fixtures[query]

    conn = SimpleNamespace(fetch=fetch, fetchval=AsyncMock(return_value=False))
    cache = {}
    expected = {
        "agent_personal_information": 4,
        "agent_email": 1,
        "agent_kai": 1,
        "agent_career": 1,
        "agent_wallet": 1,
        "agent_kyc": 1,
        "agent_calendar": 1,
        "agent_nav": 1,
        "agent_location": 2,
        "agent_documents": 1,
        "agent_connected_systems": 1,
        "agent_one": 11,
    }
    for agent, count in expected.items():
        effects, limited = await outcomes.value_effects(conn, uid, agent, NOW, NOW, cache)
        assert len(effects) == count, agent
        assert not limited
    assert len(calls) == len(fixtures)  # No repeated source scans for a multi-agent snapshot.
    unknown = await outcomes.value_summary(conn, uid, "agent_memory_merge", NOW, NOW)
    assert unknown == {
        "supported": False,
        "proof": None,
        "count": 0,
        "lastAt": None,
        "limited": False,
    }
    conn.fetchval.return_value = True
    capped = await outcomes.value_summary(conn, uid, "agent_calendar", NOW, NOW)
    assert capped["supported"] and capped["limited"] and capped["count"] == 1

    # A full default audience page must not multiply eleven sources by 25 owners.
    owners = [uid, "owner' OR 1=1 --", *[f"page-owner-{n}" for n in range(23)]]
    batch_calls = []

    async def batch_fetch(query, ids, since, now, **_):
        assert ids == owners and since == now == NOW
        assert owners[1] not in query  # Identity values are bound, never SQL source.
        batch_calls.append(query)
        if "AS capped" in query:
            return [{"_plg_user_id": owner, "capped": owner == uid} for owner in owners]
        source = next(q for q in fixtures if q.replace("$1", "owners.user_id") in query)
        rows = [{"_plg_user_id": uid, **row} for row in fixtures[source]]
        if source == outcomes.MAIL_SQL.replace("LIMIT 101", "LIMIT 1001"):
            rows.append({"_plg_user_id": owners[1], "action_id": "mail-effect", "occurred_at": NOW})
        return rows

    batch_conn = SimpleNamespace(fetch=batch_fetch)
    summaries = await outcomes.value_summaries(batch_conn, owners, "agent_one", NOW, NOW)
    assert len(batch_calls) == 11
    assert summaries[uid]["count"] == 11 and summaries[uid]["limited"]
    assert summaries[owners[1]]["count"] == 1 and not summaries[owners[1]]["limited"]
    assert all(summaries[owner]["count"] == 0 for owner in owners[2:])
    assert all(row["proof"] == "one.distinct_domain_effects.v1" for row in summaries.values())
    internal = await outcomes.value_summaries(batch_conn, owners, "agent_memory_merge", NOW, NOW)
    assert not any(row["supported"] for row in internal.values()) and len(batch_calls) == 11
    with pytest.raises(ValueError, match="bound"):
        await outcomes.value_summaries(batch_conn, [*owners, "overflow"], "agent_one", NOW, NOW)
    with pytest.raises(ValueError, match="incomplete"):
        await outcomes.value_summaries(
            SimpleNamespace(fetch=AsyncMock(return_value=[])), owners, "agent_one", NOW, NOW
        )


@pytest.mark.asyncio
async def test_value_epoch_is_pinned_before_effect_and_measurement_failure_is_optional(monkeypatch):
    from hushh_mcp.services import product_value_receipts as values

    generation = ["old-generation"]
    monkeypatch.setattr(
        values.product_activity, "admission", lambda _: {"generation": generation[0]}
    )
    pinned = await values.capture_value_epoch("owner")
    generation[0] = "reset-generation"
    calls = []
    monkeypatch.setattr(values, "_calendar_receipt", lambda *args: calls.append(args) or True)
    await values.record_calendar_effect(
        user_id="owner", kind="proposal", source_id="proposal", generation=pinned
    )
    assert calls == [("owner", "proposal", "proposal", "old-generation")]
    await values.record_calendar_effect(
        user_id="owner", kind="proposal", source_id="proposal", generation=None
    )
    assert len(calls) == 1
    monkeypatch.setattr(
        values,
        "_calendar_receipt",
        lambda *_: (_ for _ in ()).throw(RuntimeError("private db failure")),
    )
    assert (
        await values.record_calendar_effect(
            user_id="owner", kind="proposal", source_id="proposal", generation=pinned
        )
        is None
    )


def test_slow_measurement_checkout_cannot_stall_product_or_build_an_unbounded_queue(monkeypatch):
    import threading

    from hushh_mcp.services import product_value_receipts as values

    release = threading.Event()
    started = []
    pending = []
    submit = values._submit

    def track(callback):
        future = submit(callback)
        if future:
            pending.append(future)
        return future

    def slow_admission(uid):
        started.append(uid)
        release.wait(5)
        return {"generation": "late-generation"}

    monkeypatch.setattr(values.product_activity, "admission", slow_admission)
    monkeypatch.setattr(values, "_submit", track)
    try:
        for _ in range(4):
            before = time.monotonic()
            assert values.capture_value_epoch_sync("owner") is None
            assert time.monotonic() - before < 1
        before = time.monotonic()
        assert values.capture_value_epoch_sync("capacity-exceeded") is None
        assert time.monotonic() - before < 0.5
        assert started == ["owner"] * 4
    finally:
        release.set()
        for future in pending:
            future.result(timeout=2)
