"""One-click cloud routes: begin returns a caller-bound URL; complete runs the
whole chain and hands off to the one save path."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import runtime as runtime_route


@pytest.fixture(autouse=True)
def _signing(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test-signing-key-32-bytes-long!!")


async def test_begin_refuses_an_invalid_project_id():
    with pytest.raises(HTTPException) as exc:
        await runtime_route.begin_byoc_authorize(
            request=None,
            body=runtime_route.ByocAuthorizeBeginRequest(projectId="BAD_ID!"),
            firebase_uid="u1",
        )
    assert exc.value.status_code == 422


async def test_begin_returns_a_google_consent_url(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    monkeypatch.setattr(oauth, "_oauth_client", lambda: ("cid", "secret", "https://app/return"))
    result = await runtime_route.begin_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeBeginRequest(projectId="hussh-one-fresh1"),
        firebase_uid="u1",
    )
    assert result.authUrl.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "cloud-platform" in result.authUrl
    assert "access_type=online" in result.authUrl


async def test_complete_runs_create_billing_authorize_then_the_one_save_path(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    calls: list[str] = []
    monkeypatch.setattr(oauth, "verify_state", lambda state, uid: "hussh-one-fresh1")
    monkeypatch.setattr(oauth, "exchange_code", lambda code: "transient-token")
    monkeypatch.setattr(
        oauth,
        "ensure_project",
        lambda **kw: calls.append("create") or {"projectId": kw["project_id"], "created": True},
    )
    monkeypatch.setattr(
        oauth,
        "ensure_billing",
        lambda **kw: calls.append("billing") or {"billingLinked": True, "billingAccount": "b"},
    )
    monkeypatch.setattr(oauth, "apply_authorization", lambda **kw: calls.append("authorize") or {})

    async def _grant_settles(bootstrap_sa, *, deadline):
        calls.append("settle")
        return True

    monkeypatch.setattr(runtime_route, "_wait_for_bootstrap_grant", _grant_settles)

    async def _fake_save(request, body, firebase_uid):
        calls.append("save")
        return runtime_route.ByocProjectSaveResponse(
            projectId=body.projectId,
            region=body.region,
            bootstrapServiceAccount=f"one-bootstrap@{body.projectId}.iam.gserviceaccount.com",
            authorized=True,
            hushhCaller="caller@x.iam.gserviceaccount.com",
            nextStep="done",
        )

    monkeypatch.setattr(runtime_route, "save_byoc_project", _fake_save)

    result = await runtime_route.complete_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
        firebase_uid="u1",
    )
    # The order IS the contract: nothing is authorized before it exists and
    # bills, and nothing saves before the fresh grant answers.
    assert calls == ["create", "billing", "authorize", "settle", "save"]
    assert result.authorized is True
    assert result.createdProject is True
    assert result.billingLinked is True


async def test_complete_surfaces_a_typed_refusal(monkeypatch):
    from hushh_mcp.services import byoc_oauth_authorizer as oauth

    monkeypatch.setattr(oauth, "verify_state", lambda state, uid: "hussh-one-fresh1")
    monkeypatch.setattr(oauth, "exchange_code", lambda code: "t")
    monkeypatch.setattr(oauth, "ensure_project", lambda **kw: {"created": False})

    def _needs_billing(**kw):
        raise oauth.ByocAuthorizeError("no billing", status_code=409, code="NEEDS_BILLING")

    monkeypatch.setattr(oauth, "ensure_billing", _needs_billing)

    with pytest.raises(HTTPException) as exc:
        await runtime_route.complete_byoc_authorize(
            request=None,
            body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
            firebase_uid="u1",
        )
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "NEEDS_BILLING"


def _patch_chain_until_settle(monkeypatch, oauth, calls):
    monkeypatch.setattr(oauth, "verify_state", lambda state, uid: "hussh-one-fresh1")
    monkeypatch.setattr(oauth, "exchange_code", lambda code: "t")
    monkeypatch.setattr(oauth, "ensure_project", lambda **kw: {"created": False})
    monkeypatch.setattr(
        oauth, "ensure_billing", lambda **kw: {"billingLinked": False, "billingAccount": "b"}
    )
    monkeypatch.setattr(oauth, "apply_authorization", lambda **kw: {})

    async def _fake_save(request, body, firebase_uid):
        calls.append("save")
        return runtime_route.ByocProjectSaveResponse(
            projectId=body.projectId,
            region=body.region,
            bootstrapServiceAccount=f"one-bootstrap@{body.projectId}.iam.gserviceaccount.com",
            authorized=True,
            hushhCaller="caller@x.iam.gserviceaccount.com",
            nextStep="done",
        )

    monkeypatch.setattr(runtime_route, "save_byoc_project", _fake_save)


async def test_complete_waits_out_iam_propagation_before_the_save(monkeypatch):
    """The founder's flake: authorization applied, proof refused one second later.

    The grant probe fails twice (IAM still settling) and then answers; the
    complete call must ride through that without surfacing anything.
    """
    from hushh_mcp.services import byoc_oauth_authorizer as oauth
    from hushh_mcp.services import user_gcp_bootstrap

    calls: list[str] = []
    _patch_chain_until_settle(monkeypatch, oauth, calls)
    monkeypatch.setattr(runtime_route, "_GRANT_SETTLE_DELAYS_SECONDS", (0.001, 0.001, 0.001))

    probes = {"n": 0}

    def _flaky_mint(*, bootstrap_sa):
        probes["n"] += 1
        if probes["n"] < 3:
            raise user_gcp_bootstrap.BootstrapError("grant not yet visible")
        return "token"

    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", _flaky_mint)

    result = await runtime_route.complete_byoc_authorize(
        request=None,
        body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
        firebase_uid="u1",
    )
    assert probes["n"] == 3
    assert calls == ["save"]
    assert result.authorized is True


async def test_complete_refuses_typed_when_the_grant_never_settles(monkeypatch):
    """Past the bounded window, the person gets a NAMED next move, never a 500."""
    from hushh_mcp.services import byoc_oauth_authorizer as oauth
    from hushh_mcp.services import user_gcp_bootstrap

    calls: list[str] = []
    _patch_chain_until_settle(monkeypatch, oauth, calls)
    monkeypatch.setattr(runtime_route, "_GRANT_SETTLE_DELAYS_SECONDS", (0.001, 0.001))

    def _never_settles(*, bootstrap_sa):
        raise user_gcp_bootstrap.BootstrapError("grant not yet visible")

    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", _never_settles)

    with pytest.raises(HTTPException) as exc:
        await runtime_route.complete_byoc_authorize(
            request=None,
            body=runtime_route.ByocAuthorizeCompleteRequest(code="c", state="s"),
            firebase_uid="u1",
        )
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "GRANT_SETTLING"
    assert "Continue again" in exc.value.detail["message"]
    assert calls == []
