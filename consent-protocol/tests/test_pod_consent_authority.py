"""A pod asks the hub whether consent is live. SECURITY-REVIEW I1.

The distinction under test everywhere in this file is three-valued:

    valid        the authority answered yes
    invalid      the authority answered no        -> refuse (403)
    unavailable  the authority could not be asked -> 503, ask again

Collapsing the third into either neighbour is the failure this design exists to
prevent. As a denial, a hub blip becomes "your agent refuses to know you". As an
approval, a pod acts on someone's holdings with no live consent check — which is
the bypass, and it is exactly what a revoked token would slip through today,
because a pod's in-process revoked set is never populated.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `token="tok"` and `consent_token="tok"` are fixtures for
# arguments genuinely named token; no real credential appears in this file.
import pytest
from fastapi import HTTPException

from api.routes.one import pod_consent, pod_turn
from api.routes.one.pod_consent import PodConsentVerifyRequest, verify_consent_for_pod
from hushh_mcp.services import pod_consent_client
from hushh_mcp.services.pod_consent_client import ConsentVerdict, verify_consent


class _Request:
    def __init__(self) -> None:
        self.headers: dict = {}


class _Parsed:
    def __init__(self, user_id="u1", scope="pkm.read", agent_id="agent_personal") -> None:
        self.user_id = user_id
        self.scope = scope
        self.agent_id = agent_id


@pytest.fixture
def hub_enabled(monkeypatch):
    monkeypatch.setattr(pod_consent, "personal_agent_enabled", lambda: True)

    async def _is_pod(_request, _auth):
        return "hushh-abc"

    monkeypatch.setattr(pod_consent, "verify_pod_identity", _is_pod)


# -- hub side: the authority ---------------------------------------------------


async def test_the_hub_answers_valid_for_a_live_token(hub_enabled):
    def _validator(_token, expected_scope=None):
        return True, "ok", _Parsed()

    result = await verify_consent_for_pod(
        _Request(), "Bearer t", PodConsentVerifyRequest(token="tok"), validator=_validator
    )
    assert result["valid"] is True
    assert result["userId"] == "u1"


async def test_a_revoked_token_is_denied(hub_enabled):
    """The whole point: revocation state lives here, not in the pod."""

    def _validator(_token, expected_scope=None):
        return False, "Token has been revoked (DB check)", None

    result = await verify_consent_for_pod(
        _Request(), "Bearer t", PodConsentVerifyRequest(token="tok"), validator=_validator
    )
    assert result["valid"] is False
    # The reason is not echoed verbatim: a caller must not learn WHY from this
    # surface, or it becomes an oracle for token state.
    assert "revoked" not in result["reason"].lower()


async def test_a_database_failure_is_503_not_a_denial(hub_enabled):
    """"I could not check" is not "no". Returning False here would let a pod treat
    a database outage as every user's consent being withdrawn."""

    def _validator(_token, expected_scope=None):
        raise RuntimeError("pool exhausted")

    with pytest.raises(HTTPException) as exc:
        await verify_consent_for_pod(
            _Request(), "Bearer t", PodConsentVerifyRequest(token="tok"), validator=_validator
        )
    assert exc.value.status_code == 503


async def test_a_non_pod_caller_is_401(monkeypatch, hub_enabled):
    """A browser has no reason to ask whether someone's token is live."""

    async def _not_a_pod(_request, _auth):
        return None

    monkeypatch.setattr(pod_consent, "verify_pod_identity", _not_a_pod)

    with pytest.raises(HTTPException) as exc:
        await verify_consent_for_pod(_Request(), None, PodConsentVerifyRequest(token="tok"))
    assert exc.value.status_code == 401


async def test_the_surface_is_404_while_the_kill_switch_is_off(monkeypatch):
    monkeypatch.setattr(pod_consent, "personal_agent_enabled", lambda: False)
    with pytest.raises(HTTPException) as exc:
        await verify_consent_for_pod(_Request(), "Bearer t", PodConsentVerifyRequest(token="tok"))
    assert exc.value.status_code == 404


def test_the_route_is_mounted_on_the_hub():
    from api.routes.one import router as one_router

    paths = {getattr(r, "path", "") for r in one_router.routes}
    assert "/api/one/pod/consent/verify" in paths


# -- pod side: the client ------------------------------------------------------


class _Hub:
    def __init__(self, status=200, payload=None, boom=None) -> None:
        self.status = status
        self.payload = payload or {}
        self.boom = boom
        self.calls: list = []

    def post(self, path, **kwargs):
        self.calls.append((path, kwargs))
        if self.boom:
            raise self.boom

        class _R:
            status_code = self.status
            _p = self.payload

            def json(self_inner):
                return self_inner._p

        return _R()


async def test_the_client_reports_valid():
    hub = _Hub(200, {"valid": True, "userId": "u1", "scope": "pkm.read"})
    verdict = await verify_consent("tok", client=hub)
    assert verdict.valid is True and verdict.available is True
    assert verdict.user_id == "u1"


async def test_the_client_reports_a_clean_denial():
    verdict = await verify_consent("tok", client=_Hub(200, {"valid": False}))
    assert verdict.available is True
    assert verdict.valid is False
    assert verdict.should_refuse is True


async def test_an_unreachable_hub_is_unavailable_not_denied():
    verdict = await verify_consent("tok", client=_Hub(boom=ConnectionError("no route")))
    assert verdict.available is False
    # The property that matters: this must NOT read as a clean denial.
    assert verdict.should_refuse is False


@pytest.mark.parametrize("status", [401, 404, 500, 503])
async def test_every_non_200_is_unavailable_rather_than_a_denial(status):
    verdict = await verify_consent("tok", client=_Hub(status))
    assert verdict.available is False
    assert verdict.should_refuse is False


async def test_an_empty_token_needs_no_round_trip():
    hub = _Hub(200, {"valid": True})
    verdict = await verify_consent("  ", client=hub)
    assert verdict.valid is False
    assert hub.calls == []


async def test_the_expected_scope_is_sent():
    hub = _Hub(200, {"valid": True, "userId": "u1"})
    await verify_consent("tok", expected_scope="pkm.read", client=hub)
    assert hub.calls[0][1]["json"]["expectedScope"] == "pkm.read"


# -- the turn route consumes all three states ----------------------------------


@pytest.fixture
def turn_enabled(monkeypatch):
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda: ("gemini", "m"))


async def test_an_unavailable_authority_makes_the_turn_503(turn_enabled):
    """Not 403. A hub blip is not the user's consent being withdrawn."""

    async def _unavailable(_token, expected_scope=""):
        return ConsentVerdict(valid=False, available=False, reason="unreachable")

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=pod_turn.PodTurnRequest(message="hi"),
            consent_token="tok",
            verifier=_unavailable,
        )
    assert exc.value.status_code == 503


async def test_a_denied_token_makes_the_turn_403_and_never_runs_it(turn_enabled):
    ran = {"yes": False}

    async def _denied(_token, expected_scope=""):
        return ConsentVerdict(valid=False, available=True, reason="no")

    async def _run(**_kwargs):
        ran["yes"] = True
        yield None

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=pod_turn.PodTurnRequest(message="hi"),
            consent_token="tok",
            verifier=_denied,
            stream_fn=_run,
        )
    assert exc.value.status_code == 403
    assert ran["yes"] is False


def test_the_client_path_constant_matches_the_hub_route():
    """A mismatch here fails only in production, as a 404 the pod reads as a fault."""
    from api.routes.one import router as one_router

    paths = {getattr(r, "path", "") for r in one_router.routes}
    assert pod_consent_client._VERIFY_PATH in paths


# -- the audience claim --------------------------------------------------------


async def test_the_audience_is_verified_not_merely_the_signature(monkeypatch):
    """Without an audience, verify_oauth2_token checks only that Google signed it —
    so a token the pod SA minted for ANY other service would be accepted, and the
    whole decision would rest on the email claim alone. A pod mints its hub token
    audience-bound precisely so it cannot be replayed elsewhere."""
    from api.routes.one import pod_identity_auth

    seen: dict = {}

    class _FakeIdToken:
        @staticmethod
        def verify_oauth2_token(token, request, audience=None):
            seen["audience"] = audience
            return {"email": "pod@proj.iam.gserviceaccount.com", "email_verified": True}

    monkeypatch.setattr(pod_identity_auth, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(
        pod_identity_auth, "pod_hub_allowed_service_account",
        lambda: "pod@proj.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(
        pod_identity_auth, "pod_hub_expected_audience", lambda: "https://hub.example"
    )
    # `from google.oauth2 import id_token` is an ATTRIBUTE lookup on the package,
    # so patching sys.modules would not intercept it.
    import google.oauth2

    monkeypatch.setattr(google.oauth2, "id_token", _FakeIdToken, raising=False)

    req = _Request()
    req.headers = {"X-Hushh-Pod-Id": "hushh-abc"}
    result = await pod_identity_auth.verify_pod_identity(req, "Bearer tok")

    assert result == "hushh-abc"
    assert seen["audience"] == "https://hub.example"


async def test_no_configured_audience_refuses_rather_than_guessing(monkeypatch):
    """Guessing an audience is the same as not checking one."""
    from api.routes.one import pod_identity_auth

    monkeypatch.setattr(pod_identity_auth, "pod_hub_identity_auth_enabled", lambda: True)
    monkeypatch.setattr(
        pod_identity_auth, "pod_hub_allowed_service_account",
        lambda: "pod@proj.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(pod_identity_auth, "pod_hub_expected_audience", lambda: "")

    req = _Request()
    req.headers = {"X-Hushh-Pod-Id": "hushh-abc"}
    assert await pod_identity_auth.verify_pod_identity(req, "Bearer tok") is None


def test_the_expected_audience_falls_back_to_the_hub_url(monkeypatch):
    """One address, one variable. A pod mints its `aud` from HUSSH_HUB_BASE_URL; the
    hub demands the same string. Configuring those independently is a divergence that
    fails as an unexplained 401 on every pod->hub call."""
    from hushh_mcp import runtime_settings

    monkeypatch.delenv("POD_HUB_EXPECTED_AUDIENCE", raising=False)
    monkeypatch.setenv("HUSSH_HUB_BASE_URL", "https://hub.example")
    assert runtime_settings.pod_hub_expected_audience() == "https://hub.example"


@pytest.mark.parametrize(
    ("explicit", "hub_url"),
    [("https://hub.example/", ""), ("", "https://hub.example/")],
)
def test_a_trailing_slash_never_decides_the_outcome(monkeypatch, explicit, hub_url):
    """`pod_hub_client.hub_base_url` rstrips the slash before minting. Normalising on
    only one side fails every verification while both values LOOK equal in a console
    listing -- which is the worst possible way for this to break."""
    from hushh_mcp import runtime_settings

    monkeypatch.setenv("POD_HUB_EXPECTED_AUDIENCE", explicit)
    monkeypatch.setenv("HUSSH_HUB_BASE_URL", hub_url)
    assert runtime_settings.pod_hub_expected_audience() == "https://hub.example"


def test_neither_configured_still_refuses(monkeypatch):
    """The override exists for a hub behind a load balancer, where the address a pod
    dials is not the one this service knows itself by. Absent both, guessing an
    audience is the same as not checking one."""
    from hushh_mcp import runtime_settings

    monkeypatch.delenv("POD_HUB_EXPECTED_AUDIENCE", raising=False)
    monkeypatch.delenv("HUSSH_HUB_BASE_URL", raising=False)
    assert runtime_settings.pod_hub_expected_audience() == ""


def test_an_explicit_override_wins_over_the_hub_url(monkeypatch):
    from hushh_mcp import runtime_settings

    monkeypatch.setenv("POD_HUB_EXPECTED_AUDIENCE", "https://custom.example")
    monkeypatch.setenv("HUSSH_HUB_BASE_URL", "https://internal.run.app")
    assert runtime_settings.pod_hub_expected_audience() == "https://custom.example"


async def test_the_hub_returns_the_owner_binding(hub_enabled):
    """The pod cannot resolve user -> HusshID; only the hub can, so only the hub
    can supply the binding the pod enforces."""

    class _Repo:
        async def get(self, _user_id):
            return {"hushh_id": "hushh-owner-1"}

    def _validator(_token, expected_scope=None):
        return True, "ok", _Parsed()

    result = await verify_consent_for_pod(
        _Request(), "Bearer t", PodConsentVerifyRequest(token="tok"),
        validator=_validator, registry=_Repo(),
    )
    assert result["hushhId"] == "hushh-owner-1"


async def test_an_unresolvable_binding_returns_empty_not_a_guess(hub_enabled):
    class _Broken:
        async def get(self, _user_id):
            raise RuntimeError("registry down")

    def _validator(_token, expected_scope=None):
        return True, "ok", _Parsed()

    result = await verify_consent_for_pod(
        _Request(), "Bearer t", PodConsentVerifyRequest(token="tok"),
        validator=_validator, registry=_Broken(),
    )
    # Empty, and the POD refuses on empty. Never a fabricated binding.
    assert result["hushhId"] == ""
