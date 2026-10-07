"""The generic OAuth dispatcher must never reopen curated rows as legacy OAuth.

The registry is operator-writable. Its `chat` admission is useful for the
catalog, but it is not an authority boundary for choosing the adapter that
will read secrets or send an authorization code. These tests use no network or
database and exercise the real curated configuration guard through the generic
wrapper.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services import external_connector_curated_oauth as curated_oauth
from hushh_mcp.services import external_connector_oauth_service as generic_oauth
from hushh_mcp.services.curated_connector_manifest import get_manifest
from hushh_mcp.services.external_connector_registry_service import ExternalMcpConnectorDefinition


def _notion_row(policy: dict[str, str]) -> ExternalMcpConnectorDefinition:
    manifest = get_manifest("notion")
    assert manifest is not None
    return ExternalMcpConnectorDefinition(
        connector_id="notion",
        display_name=manifest.display_name,
        description=manifest.description,
        mcp_endpoint=manifest.mcp_endpoint,
        auth_style="oauth",
        oauth_authorize_url=manifest.authorize_url,
        oauth_token_url="https://unreviewed.example/token",  # noqa: S106 - public test URL
        oauth_scopes=manifest.scopes,
        oauth_client_id_env="UNRELATED_SECRET",
        oauth_client_secret_env="UNRELATED_SECRET",  # noqa: S106 - env variable name, not a secret
        api_key_header_name=None,
        is_active=True,
        transport_kind="mcp",
        capability_policy=policy,
        registered_redirect_uris=manifest.redirect_uris["uat"],
        owner_user_id=None,
    )


def _adapter(
    wrapper: generic_oauth.ExternalConnectorOAuthService,
    registry: SimpleNamespace,
    credentials: SimpleNamespace,
    lifecycle: SimpleNamespace,
) -> curated_oauth.ExternalConnectorCuratedOAuth:
    return curated_oauth.ExternalConnectorCuratedOAuth(
        registry=registry,
        credentials=credentials,
        lifecycle=lifecycle,
        state_codec=wrapper,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [{}, {"chat": "unreviewed"}])
async def test_operator_owned_row_never_falls_back_to_legacy_oauth_start(monkeypatch, policy):
    row = _notion_row(policy)
    registry = SimpleNamespace(get_connector=AsyncMock(return_value=row))
    credentials = SimpleNamespace(encrypt_secret=Mock(side_effect=AssertionError("legacy path")))
    wrapper = generic_oauth.ExternalConnectorOAuthService(
        db=object(), registry=registry, credentials=credentials
    )
    adapter = _adapter(
        wrapper,
        registry,
        credentials,
        SimpleNamespace(start_attempt=AsyncMock(side_effect=AssertionError("legacy path"))),
    )
    wrapper.curated = lambda: adapter
    wrapper._execute = AsyncMock(side_effect=AssertionError("legacy database path"))
    env_read = Mock(return_value="legacy-client")
    monkeypatch.setattr(generic_oauth.os, "getenv", env_read)
    monkeypatch.setattr(curated_oauth, "getenv", env_read)

    with pytest.raises(curated_oauth.CuratedConnectorOAuthError, match="connector_unavailable"):
        await wrapper.start(
            user_id="owner", connector_id="notion", redirect_uri=row.registered_redirect_uris[0]
        )

    wrapper._execute.assert_not_called()
    env_read.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("connector_id", ["unreviewed_crm", "pendingco"])
async def test_operator_owned_row_without_a_runtime_manifest_never_reopens_legacy_oauth(
    monkeypatch, registration_only_provider, connector_id
):
    # "pendingco" is a registration-only provider (spec, no runtime manifest);
    # attio now has a manifest, so it no longer represents this case.
    assert get_manifest(connector_id) is None
    source = _notion_row({"chat": "reviewed"})
    row = ExternalMcpConnectorDefinition(
        connector_id=connector_id,
        display_name=source.display_name,
        description=source.description,
        mcp_endpoint=source.mcp_endpoint,
        auth_style=source.auth_style,
        oauth_authorize_url=source.oauth_authorize_url,
        oauth_token_url=source.oauth_token_url,
        oauth_scopes=source.oauth_scopes,
        oauth_client_id_env=source.oauth_client_id_env,
        oauth_client_secret_env=source.oauth_client_secret_env,
        api_key_header_name=source.api_key_header_name,
        is_active=source.is_active,
        transport_kind=source.transport_kind,
        capability_policy=source.capability_policy,
        registered_redirect_uris=source.registered_redirect_uris,
        owner_user_id=None,
    )
    registry = SimpleNamespace(get_connector=AsyncMock(return_value=row))
    credentials = SimpleNamespace(encrypt_secret=Mock(side_effect=AssertionError("legacy path")))
    wrapper = generic_oauth.ExternalConnectorOAuthService(
        db=object(), registry=registry, credentials=credentials
    )
    adapter = _adapter(
        wrapper,
        registry,
        credentials,
        SimpleNamespace(start_attempt=AsyncMock(side_effect=AssertionError("legacy path"))),
    )
    wrapper.curated = lambda: adapter
    wrapper._execute = AsyncMock(side_effect=AssertionError("legacy database path"))
    monkeypatch.setattr(curated_oauth, "getenv", Mock(return_value="legacy-client"))

    with pytest.raises(
        curated_oauth.CuratedConnectorOAuthError, match="connector_configuration_invalid"
    ):
        await wrapper.start(
            user_id="owner",
            connector_id=row.connector_id,
            redirect_uri=row.registered_redirect_uris[0],
        )

    wrapper._execute.assert_not_called()
    credentials.encrypt_secret.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [{}, {"chat": "unreviewed"}])
async def test_operator_owned_row_never_falls_back_to_legacy_oauth_complete(monkeypatch, policy):
    row = _notion_row(policy)
    registry = SimpleNamespace(get_connector=AsyncMock(return_value=row))
    credentials = SimpleNamespace(decrypt_secret=Mock(side_effect=AssertionError("legacy path")))
    wrapper = generic_oauth.ExternalConnectorOAuthService(
        db=object(), registry=registry, credentials=credentials
    )
    attempt = {
        "attempt_id": "attempt-1",
        "user_id": "owner",
        "connector_id": "notion",
        "oauth_client_id": "irrelevant",
        "redirect_uri": row.registered_redirect_uris[0],
        "code_verifier_ciphertext": "ct",
        "code_verifier_iv": "iv",
    }
    adapter = _adapter(
        wrapper,
        registry,
        credentials,
        SimpleNamespace(claim_attempt=AsyncMock(return_value=attempt)),
    )
    wrapper.curated = lambda: adapter
    wrapper._verify_state = lambda _state: "attempt-1"
    wrapper._execute = AsyncMock(
        return_value=[
            {
                **attempt,
                "expires_at": datetime.now(UTC) + timedelta(minutes=5),
                "consumed_at": None,
            }
        ]
    )
    monkeypatch.setattr(
        generic_oauth.httpx, "AsyncClient", Mock(side_effect=AssertionError("legacy HTTP"))
    )
    monkeypatch.setattr(curated_oauth, "getenv", Mock(return_value="legacy-client"))

    with pytest.raises(curated_oauth.CuratedConnectorOAuthError, match="connector_unavailable"):
        await wrapper.complete(state="signed-state", code="code", expected_user_id="owner")

    assert wrapper._execute.await_count == 1
    credentials.decrypt_secret.assert_not_called()


def _popup_wrapper(row, attempt_rows, lifecycle=None):
    registry = SimpleNamespace(get_connector=AsyncMock(return_value=row))
    credentials = SimpleNamespace(decrypt_secret=Mock(side_effect=AssertionError("legacy path")))
    wrapper = generic_oauth.ExternalConnectorOAuthService(
        db=object(), registry=registry, credentials=credentials
    )
    wrapper._verify_state = lambda _state: "attempt-1"
    wrapper._execute = AsyncMock(return_value=attempt_rows)
    if lifecycle is not None:
        wrapper.curated = lambda: _adapter(wrapper, registry, credentials, lifecycle)
    return wrapper


@pytest.mark.asyncio
async def test_popup_completion_passes_the_caller_identity_to_the_curated_claim():
    # The real adapter refuses the attempt when the atomic claim, which is bound
    # to the Firebase user the route passes, does not match the attempt owner.
    lifecycle = SimpleNamespace(claim_attempt=AsyncMock(return_value=None))
    wrapper = _popup_wrapper(
        _notion_row({"chat": "reviewed"}), [{"connector_id": "notion"}], lifecycle
    )

    with pytest.raises(curated_oauth.CuratedConnectorOAuthError, match="attempt_unavailable"):
        await wrapper.complete_web_popup(state="signed", code="code", expected_user_id="intruder")

    lifecycle.claim_attempt.assert_awaited_once_with(attempt_id="attempt-1", user_id="intruder")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("attempt_rows", "registry_row"),
    [
        ([], None),
        ([{"connector_id": "legacy_crm"}], None),
        ([{"connector_id": "legacy_crm"}], SimpleNamespace(owner_user_id="private-owner")),
    ],
)
async def test_popup_completion_refuses_everything_but_drive_and_operator_rows(
    monkeypatch, attempt_rows, registry_row
):
    wrapper = _popup_wrapper(registry_row, attempt_rows)
    wrapper.complete = AsyncMock(side_effect=AssertionError("vault-only legacy path"))
    wrapper.drive = Mock(side_effect=AssertionError("drive adapter"))
    wrapper.curated = Mock(side_effect=AssertionError("curated adapter"))
    http = Mock(side_effect=AssertionError("legacy HTTP"))
    monkeypatch.setattr(generic_oauth.httpx, "AsyncClient", http)

    with pytest.raises(generic_oauth.ExternalConnectorOAuthError) as refused:
        await wrapper.complete_web_popup(state="signed", code="code", expected_user_id="owner")

    assert refused.value.status_code == 409
    http.assert_not_called()
    wrapper.complete.assert_not_called()


@pytest.mark.asyncio
async def test_popup_completion_keeps_drive_on_the_drive_adapter():
    drive = SimpleNamespace(complete=AsyncMock(return_value={"status": "verifying"}))
    wrapper = _popup_wrapper(None, [{"connector_id": "google_drive"}])
    wrapper.drive = lambda: drive
    wrapper.curated = Mock(side_effect=AssertionError("curated adapter"))

    result = await wrapper.complete_web_popup(state="signed", code="code", expected_user_id="owner")

    assert result == {"status": "verifying"}
    drive.complete.assert_awaited_once_with(state="signed", code="code", expected_user_id="owner")
