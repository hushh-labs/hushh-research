"""Real SQL OAuth journeys: identity survives rotation without granting access."""

import base64
import hashlib

import pytest
from sqlalchemy import create_engine

from db.db_client import DatabaseClient
from hushh_mcp.services.developer_oauth_service import DeveloperOAuthService, OAuthValidationError
from hushh_mcp.services.developer_registry_service import DeveloperRegistryService
from hushh_mcp.services.mcp_oauth_resource import configured_mcp_origin

RESOURCE = "https://mcp.example.test/mcp"
REDIRECT = "https://assistant.example.test/callback"
VERIFIER = "v" * 43


@pytest.fixture
def oauth(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_OFFLINE", "1")
    monkeypatch.setenv("CONSENT_API_PUBLIC_ORIGIN", "https://mcp.example.test")
    monkeypatch.setattr(DeveloperOAuthService, "_tables_ensured", False)
    engine = create_engine(f"sqlite:///{tmp_path / 'oauth.db'}")
    db = DatabaseClient(engine)
    db.execute_raw("""CREATE TABLE developer_apps (
        app_id TEXT PRIMARY KEY, agent_id TEXT, display_name TEXT, allowed_tool_groups TEXT,
        allowed_capabilities TEXT, support_url TEXT, policy_url TEXT, website_url TEXT,
        brand_image_url TEXT, contact_email TEXT, kind TEXT, crm_id TEXT, schema_profile TEXT,
        oauth_client_credentials_enabled INTEGER, status TEXT)""")
    db.execute_raw("""INSERT INTO developer_apps
        (app_id, agent_id, display_name, allowed_tool_groups, kind, status)
        VALUES ('app_test', 'developer:app_test', 'Test assistant', '["core_consent"]',
                'self_serve', 'active')""")
    service = DeveloperOAuthService.__new__(DeveloperOAuthService)
    service._db = db
    service._registry = DeveloperRegistryService.__new__(DeveloperRegistryService)
    service.ensure_tables()
    db.execute_raw(
        """INSERT INTO developer_oauth_clients
        (app_id, client_id, client_secret_hash, client_secret_prefix, redirect_uris,
         created_at, secret_rotated_at)
        VALUES ('app_test', 'client_test', 'unused', 'unused', :redirects, 1, 1)""",
        {"redirects": '["' + REDIRECT + '"]'},
    )
    yield service
    engine.dispose()


def issue(oauth, owner="owner_a", resource=RESOURCE):
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")
    )
    ref = oauth.begin_authorization(
        client_id="client_test",
        redirect_uri=REDIRECT,
        code_challenge=challenge,
        state="test",
        scope="mcp:tools",
        resource=resource,
    )
    code = oauth.approve_authorization(transaction_ref=ref, subject_firebase_uid=owner)
    client = oauth.get_client("client_test")
    tokens = oauth.exchange_authorization_code(
        client=client, code=code, redirect_uri=REDIRECT, code_verifier=VERIFIER, resource=resource
    )
    return client, tokens


def test_owner_client_and_audience_survive_refresh(oauth):
    client, tokens = issue(oauth)
    first = oauth.authenticate_access_token(tokens["access_token"])
    assert first.subject_firebase_uid == "owner_a"
    assert first.oauth_client_id == "client_test"
    assert first.oauth_resource == RESOURCE
    assert first.oauth_scopes == ("mcp:tools",)
    assert first.allowed_tool_groups == ("core_consent",)
    refreshed = oauth.refresh(
        client=client, refresh_token=tokens["refresh_token"], resource=RESOURCE
    )
    second = oauth.authenticate_access_token(refreshed["access_token"])
    assert second.subject_firebase_uid == first.subject_firebase_uid
    assert second.authorization_id == first.authorization_id
    with pytest.raises(OAuthValidationError, match="Refresh token validation failed"):
        oauth.refresh(client=client, refresh_token=tokens["refresh_token"], resource=RESOURCE)


@pytest.mark.parametrize("resource", [None, "", "https://foreign.test/mcp", RESOURCE + "/"])
def test_refresh_cannot_omit_or_change_bound_resource(oauth, resource):
    client, tokens = issue(oauth)
    with pytest.raises(OAuthValidationError) as failure:
        oauth.refresh(client=client, refresh_token=tokens["refresh_token"], resource=resource)
    assert failure.value.code == "invalid_target"
    # An invalid request must not consume the valid credential.
    assert oauth.refresh(client=client, refresh_token=tokens["refresh_token"], resource=RESOURCE)


def test_bound_access_token_refused_on_another_deployment(oauth, monkeypatch):
    _, tokens = issue(oauth)
    monkeypatch.setenv("CONSENT_API_PUBLIC_ORIGIN", "https://another-environment.test")
    assert oauth.authenticate_access_token(tokens["access_token"]) is None


def test_legacy_developer_flow_stays_unbound(oauth):
    client, tokens = issue(oauth, resource=None)
    assert oauth.authenticate_access_token(tokens["access_token"]).oauth_resource is None
    assert oauth.refresh(client=client, refresh_token=tokens["refresh_token"])


def test_client_credentials_and_registry_cannot_claim_owner_identity():
    for source, grant_type in [("registry", "authorization_code"), ("oauth", "client_credentials")]:
        principal = DeveloperRegistryService._principal_from_row(
            {
                "auth_source": source,
                "grant_type": grant_type,
                "subject_firebase_uid": "forged",
            }
        )
        assert principal.subject_firebase_uid is None


def test_revoked_client_stops_existing_access(oauth):
    _, tokens = issue(oauth)
    oauth._db.execute_raw("UPDATE developer_oauth_clients SET revoked_at = 1")
    assert oauth.authenticate_access_token(tokens["access_token"]) is None


def test_orphaned_authorization_cannot_downgrade_bound_credentials(oauth):
    client, tokens = issue(oauth)
    oauth._db.execute_raw("DELETE FROM developer_oauth_authorizations")
    assert oauth.authenticate_access_token(tokens["access_token"]) is None
    with pytest.raises(OAuthValidationError):
        oauth.refresh(client=client, refresh_token=tokens["refresh_token"])


def test_authorization_denial_fences_already_issued_tokens(oauth):
    client, tokens = issue(oauth)
    oauth._db.execute_raw("UPDATE developer_oauth_authorizations SET status = 'denied'")
    assert oauth.authenticate_access_token(tokens["access_token"]) is None
    with pytest.raises(OAuthValidationError):
        oauth.refresh(client=client, refresh_token=tokens["refresh_token"], resource=RESOURCE)


def test_resource_mismatch_does_not_consume_authorization_code(oauth):
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")
    )
    ref = oauth.begin_authorization(
        client_id="client_test",
        redirect_uri=REDIRECT,
        code_challenge=challenge,
        state="test",
        scope="mcp:tools",
        resource=RESOURCE,
    )
    code = oauth.approve_authorization(transaction_ref=ref, subject_firebase_uid="owner_a")
    client = oauth.get_client("client_test")
    for wrong in (None, "https://another.test/mcp"):
        with pytest.raises(OAuthValidationError) as failure:
            oauth.exchange_authorization_code(
                client=client,
                code=code,
                redirect_uri=REDIRECT,
                code_verifier=VERIFIER,
                resource=wrong,
            )
        assert failure.value.code == "invalid_target"
    assert oauth.exchange_authorization_code(
        client=client, code=code, redirect_uri=REDIRECT, code_verifier=VERIFIER, resource=RESOURCE
    )


def test_preexisting_offline_database_gets_additive_resource_column(oauth, monkeypatch):
    oauth._db.execute_raw("ALTER TABLE developer_oauth_authorizations DROP COLUMN resource")
    monkeypatch.setattr(DeveloperOAuthService, "_tables_ensured", False)
    oauth.ensure_tables()
    _, tokens = issue(oauth)
    assert oauth.authenticate_access_token(tokens["access_token"]).oauth_resource == RESOURCE


@pytest.mark.parametrize(
    "origin",
    [
        "https://x.test/path",
        "https://user:pass@x.test",
        "http://x.test",
        "https://x.test?query",
        "https://x.test\r\nInjected: value",
    ],
)
def test_configured_origin_cannot_create_unsafe_audience_or_challenge(monkeypatch, origin):
    monkeypatch.setenv("CONSENT_API_PUBLIC_ORIGIN", origin)
    with pytest.raises(ValueError):
        configured_mcp_origin()
