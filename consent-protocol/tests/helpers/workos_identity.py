"""Shared, synthetic WorkOS/Firebase boundaries for the owning lifecycle suites."""

import hashlib
import hmac
import json
import time
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hushh_mcp.services.enterprise_sso import EnterpriseSsoError, EnterpriseSsoService
from hushh_mcp.services.enterprise_sso.firebase_identity import (
    CLAIM_DEPROVISIONED_AT,
    CLAIM_ORG,
    CLAIM_ORIGIN,
    CLAIM_USER,
    FirebaseUserInfo,
)
from hushh_mcp.services.enterprise_sso.membership import CapturedMembership, membership_hash
from hushh_mcp.services.enterprise_sso.workos_adapter import (
    DirectoryMembership,
    SsoProfile,
    WorkOSConfig,
    WorkOSOrganization,
    WorkOSSdkAdapter,
    sign_state,
)

SECRET = "whsec_test"


WRONG_SECRET = "not-the-webhook-secret"


API_KEY = "sk_test_key"


CONFIG = WorkOSConfig(
    api_key=API_KEY,
    client_id="client_1",
    webhook_secret=SECRET,
    redirect_uri="https://app.example/cb",
)


def _sign(body: bytes, *, secret: str = SECRET, issued_ms: int | None = None) -> str:
    issued = str(int(time.time() * 1000) if issued_ms is None else issued_ms)
    digest = hmac.new(secret.encode(), issued.encode() + b"." + body, hashlib.sha256).hexdigest()
    return f"t={issued}, v1={digest}"


_TS = "2026-01-01T00:00:00.000Z"


def _sdk_org(domains):
    from workos.organizations.models.organization import Organization

    return Organization.from_dict(
        {
            "object": "organization",
            "id": "org_01",
            "name": "Acme",
            "domains": [
                {
                    "object": "organization_domain",
                    "id": f"d{i}",
                    "organization_id": "org_01",
                    "domain": domain,
                    "state": state,
                    "created_at": _TS,
                    "updated_at": _TS,
                }
                for i, (domain, state) in enumerate(domains)
            ],
            "metadata": {},
            "external_id": None,
            "stripe_customer_id": None,
            "created_at": _TS,
            "updated_at": _TS,
            "allow_profiles_outside_organization": False,
        }
    )


def _sdk_connection(state):
    from workos.sso.models.connection import Connection

    return Connection.from_dict(
        {
            "object": "connection",
            "id": "conn_1",
            "organization_id": "org_01",
            "connection_type": "GenericSAML",
            "name": "Acme SSO",
            "state": state,
            "domains": [],
            "created_at": _TS,
            "updated_at": _TS,
        }
    )


def _real_adapter(orgs, connection_states, api_key="sk_test_x"):
    adapter = WorkOSSdkAdapter(
        WorkOSConfig(api_key=api_key, client_id="client_x", redirect_uri="https://a.example/b")
    )
    connections = [_sdk_connection(state) for state in connection_states]
    adapter._client = SimpleNamespace(
        organizations=SimpleNamespace(
            get_organization=lambda _id: orgs[0],
            list_organizations=lambda **_: SimpleNamespace(data=orgs),
        ),
        sso=SimpleNamespace(list_connections=lambda **_: SimpleNamespace(data=connections)),
    )
    return adapter


def _acme(**overrides):
    values = {
        "id": "org_01",
        "name": "Acme",
        "verified_domains": frozenset({"acme.example"}),
        "sso_disabled": False,
    }
    return WorkOSOrganization(**{**values, **overrides})


class FakeWorkOS:
    """WorkOS is the authority: it owns the organizations, their verified domains and connections."""

    def __init__(self):
        self.profile = SsoProfile(
            id="prof_1",
            organization_id="org_01",
            email="Ada@Acme.example",
            connection_id="conn_1",
            idp_id="idp_1",
        )
        self.orgs = {"org_01": _acme()}
        self.urls = []
        self.redirects = []

    def find_organization_by_domain(self, domain):
        for org in self.orgs.values():
            if domain in org.verified_domains and not org.sso_disabled:
                return org
        return None

    def get_organization(self, organization_id):
        return self.orgs.get(organization_id)

    def authorization_url(self, *, organization_id, state, login_hint, redirect_uri=None):
        self.urls.append((organization_id, login_hint))
        self.redirects.append(redirect_uri)
        return f"https://workos.example/authorize?organization={organization_id}&state={state}"

    def directory_membership(self, profile):
        return DirectoryMembership("directory_1", "directory_user_1")

    def exchange_code(self, code):
        if code != "good-code":
            raise EnterpriseSsoError("sso_code_invalid", 400)
        return self.profile


class FakeMemberships:
    def __init__(self):
        self.bindings = {}
        self.retired = set()
        self.offboarded = set()

    def capture(self, owner, profile, directory, origin):
        if owner in self.retired:
            raise EnterpriseSsoError("sso_account_deleted", 403)
        if directory is None:
            existing = [
                (key, value)
                for key, value in self.bindings.items()
                if value.profile_hash == membership_hash(profile.organization_id, profile.id)
            ]
            if not existing:
                return None
            key, value = existing[0]
            if key in self.offboarded or owner in self.retired:
                raise EnterpriseSsoError("sso_deprovisioned", 403)
            if value.owner_id != owner:
                raise EnterpriseSsoError("sso_account_conflict", 409)
            return membership_hash(*key)
        key = (profile.organization_id, directory.directory_id, directory.user_id)
        value = CapturedMembership(
            owner, origin, membership_hash(profile.organization_id, profile.id)
        )
        if key in self.offboarded:
            raise EnterpriseSsoError("sso_deprovisioned", 403)
        if key in self.bindings and self.bindings[key] != value:
            raise EnterpriseSsoError("sso_account_conflict", 409)
        self.bindings[key] = value
        return membership_hash(*key)

    def offboard(self, org, directory, person):
        key = (org, directory, person)
        if key not in self.bindings:
            raise EnterpriseSsoError("sso_directory_binding_required", 503)
        self.offboarded.add(key)
        value = self.bindings[key]
        return replace(value, owner_id=None) if value.owner_id in self.retired else value


class FakeFirebase:
    """Firebase is the account store: users, claims, the disabled flag and session revocation."""

    def __init__(self):
        self.users = {}  # uid -> {"email", "verified", "disabled", "claims"}
        self.minted = []
        self.quarantined = []
        self.sessions_revoked = []
        self.quarantine_ok = True

    def add(self, uid, email, *, verified=True, disabled=False, display_name=None, **claims):
        self.users[uid] = {
            "email": email,
            "verified": verified,
            "disabled": disabled,
            "claims": dict(claims),
            "display_name": display_name,
        }

    def _info(self, uid):
        user = self.users[uid]
        return FirebaseUserInfo(
            uid=uid,
            email_verified=user["verified"],
            disabled=user["disabled"],
            claims=dict(user["claims"]),
            display_name=user["display_name"],
        )

    async def get_user(self, uid):
        return self._info(uid) if uid in self.users else None

    async def find_by_email(self, email):
        return next((self._info(uid) for uid, u in self.users.items() if u["email"] == email), None)

    async def create_user(self, uid, email, display_name=None):
        if uid in self.users:
            return  # idempotent, like the real adapter
        if any(u["email"] == email for u in self.users.values()):
            raise EnterpriseSsoError("sso_email_conflict", 409)
        self.add(uid, email, display_name=display_name)

    async def set_display_name(self, uid, display_name):
        self.users[uid]["display_name"] = display_name

    async def merge_claims(self, uid, updates):
        self.users[uid]["claims"] = {**self.users[uid]["claims"], **updates}

    async def mint_token(self, uid, claims):
        self.minted.append((uid, claims))
        return f"token:{uid}"

    async def offboard(self, uid, origin, organization, profile_hash):
        self.users[uid]["claims"].setdefault(CLAIM_DEPROVISIONED_AT, int(time.time()))
        if origin == "created":
            self.quarantined.append(uid)
            if self.quarantine_ok:
                self.users[uid]["disabled"] = True
            return self.quarantine_ok
        self.sessions_revoked.append(uid)
        return True


class FakeConsent:
    def __init__(self):
        self.revoked = []

    async def revoke_all_active_grants(self, user_id):
        self.revoked.append(user_id)
        return 1


@pytest.fixture
def world():
    workos, firebase, consent = FakeWorkOS(), FakeFirebase(), FakeConsent()
    deleted = set()
    memberships = FakeMemberships()
    service = EnterpriseSsoService(
        workos=workos,
        config=CONFIG,
        firebase=firebase,
        consent=consent,
        is_tombstoned=lambda uid: uid in deleted,
        memberships=memberships,
    )
    return SimpleNamespace(
        service=service,
        workos=workos,
        firebase=firebase,
        consent=consent,
        deleted=deleted,
        memberships=memberships,
    )


async def _sign_in(world):
    return await world.service.exchange(code="good-code", state=sign_state(API_KEY, "org_01"))


def _event(event_type, data, event_id="event_1"):
    return json.dumps({"id": event_id, "event": event_type, "data": data}).encode()


def _deleted(
    email="ada@acme.example", org="org_01", directory="directory_1", person="directory_user_1"
):
    return _event(
        "dsync.user.deleted",
        {"id": person, "directory_id": directory, "organization_id": org, "email": email},
    )


async def _webhook(world, body):
    return await world.service.handle_webhook(body=body, signature=_sign(body))


@pytest.fixture
def active_firebase_account(monkeypatch):
    from api.utils import firebase_auth as firebase_auth_module
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    firebase_auth_module._clear_revocation_cache_for_tests()
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "is_tombstoned",
        lambda _uid: False,
    )
    try:
        yield
    finally:
        firebase_auth_module._clear_revocation_cache_for_tests()


def directory_models(case):
    from workos.directory_sync.models.directory import Directory
    from workos.directory_sync.models.directory_user_with_groups import DirectoryUserWithGroups

    directory = Directory.from_dict(
        {
            "id": "directory_1",
            "organization_id": "org_01",
            "external_key": "external",
            "type": "generic scim v2.0",
            "state": "linked",
            "name": "Acme",
            "created_at": _TS,
            "updated_at": _TS,
        }
    )
    user = DirectoryUserWithGroups.from_dict(
        {
            "id": "directory_user_1",
            "directory_id": "directory_1",
            "organization_id": "org_01",
            "idp_id": "idp_1",
            "email": "irrelevant@example.com",
            "state": "inactive" if case == "inactive" else "active",
            "custom_attributes": {},
            "groups": [],
            "created_at": _TS,
            "updated_at": _TS,
        }
    )
    profile = SsoProfile(
        "prof_1",
        "org_01",
        "ada@acme.example",
        connection_id="conn_1",
        idp_id=None if case == "missing_idp" else "idp_1",
    )
    return directory, user, profile


def _routes_client(monkeypatch, *, enabled, secret=None):
    from api.routes import workos as routes

    monkeypatch.delenv("WORKOS_SSO_ENABLED", raising=False)
    monkeypatch.delenv("WORKOS_WEBHOOK_SECRET", raising=False)
    if enabled:
        monkeypatch.setenv("WORKOS_SSO_ENABLED", "true")
    if secret:
        monkeypatch.setenv("WORKOS_WEBHOOK_SECRET", secret)
    app = FastAPI()
    app.include_router(routes.router)
    app.include_router(routes.webhook_router)
    return TestClient(app)


def _request(forwarded=None, peer="10.0.0.1"):
    from starlette.requests import Request

    headers = [(b"x-forwarded-for", forwarded.encode())] if forwarded else []
    return Request({"type": "http", "headers": headers, "client": (peer, 1234)})


def offboarding_provider(monkeypatch, origin, changed, lost):
    from hushh_mcp.services import account_firebase_mutations as mutations
    from hushh_mcp.services.enterprise_sso.firebase_identity import FirebaseAdminIdentity

    identity = FirebaseAdminIdentity()
    app = SimpleNamespace(project_id="synthetic-project")
    current = {
        CLAIM_ORG: "another-org" if changed else "org_01",
        CLAIM_USER: "prof_1",
        CLAIM_ORIGIN: origin,
        "unrelated": "preserved",
    }
    sdk = SimpleNamespace(get_user=lambda uid, **_: SimpleNamespace(custom_claims=current))
    monkeypatch.setattr(identity, "_write_auth", lambda: (sdk, app))
    permit = mutations.FirebaseMutationPermit(
        "operation", "owner", "identity", "nonce", "captured-uid"
    )
    settlements, writes = [], []
    monkeypatch.setattr(mutations, "begin", lambda owner, **kwargs: permit)
    monkeypatch.setattr(mutations, "settle", lambda p, state: settlements.append((p, state)))

    def write(_app, uid, fields):
        writes.append((uid, fields))
        if lost:
            raise ConnectionError("synthetic lost response")

    monkeypatch.setattr(mutations, "_update_identity", write)
    return identity, permit, settlements, writes
