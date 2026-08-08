"""Browser -> hub -> pod. The last link, and the one that carries the authority.

Everything before this made a pod exist and be reachable. This is what lets a
person's message reach the agent running on it, and it is the place where the
question "with whose authority?" gets answered.

Two properties do the work:

  * the consent token is minted HERE, server-side, and is a `pkm.read` grant. It is
    never accepted from the caller -- the only token a browser actually holds is
    `vault.owner`, the master grant, and forwarding that would hand the pod
    everything its person has;
  * the pod's ADDRESS comes only from the row the hub wrote at service creation, so
    there is nothing for a caller to point the proxy at.

Non-streaming, matching `pod_turn.py`. That route collects its events into one
response so a First Light failure is attributable to the agent rather than to
transport; changing both contracts at once would make the first real failure
ambiguous.
"""

from __future__ import annotations

# ruff: noqa: S105, S106 -- token fixtures for arguments genuinely named token.
import pytest
from fastapi import HTTPException

from api.routes.one import pod_relay
from api.routes.one.pod_relay import PodTurnRelayRequest, relay_pod_turn

POD_URL = "https://one-pod-abc-uc.a.run.app"


class _Registry:
    def __init__(self, row: dict | None = None) -> None:
        self.row = (
            row
            if row is not None
            else {
                "user_id": "u1",
                "status": "provisioned",
                "backend_metadata": {"url": POD_URL},
            }
        )

    async def get(self, _user_id):
        return self.row


class _Audit:
    def __init__(self, *, denied: bool = False) -> None:
        self.denied = denied
        self.calls: list[dict] = []

    async def authorize_owner_read(self, **kwargs):
        self.calls.append(kwargs)
        if self.denied:
            from hushh_mcp.services.pod_access_audit import PodAccessDenied

            raise PodAccessDenied("not the owner")
        return True


class _Pod:
    """Stands in for `requests`, recording exactly what crossed the boundary."""

    def __init__(self, status=200, payload=None, boom=None) -> None:
        self.status = status
        self.payload = payload if payload is not None else {"text": "hello", "grounded": False}
        self.boom = boom
        self.calls: list[dict] = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if self.boom:
            raise self.boom
        outer = self

        class _R:
            status_code = outer.status

            def json(self_inner):
                return outer.payload

        return _R()


async def _grants(_user_id):
    return {"token": "standing-pkm-read", "scope": "pkm.read", "reused": True}


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    monkeypatch.setattr(pod_relay, "personal_agent_enabled", lambda: True)
    # No metadata server in a test process; the hub identity is orthogonal here.
    monkeypatch.setattr(pod_relay, "_identity_token", lambda _audience: "hub-id-token")


async def _turn(**kwargs):
    defaults = {
        "hushh_id": "hushh-abc",
        "user_id": "u1",
        "payload": PodTurnRelayRequest(message="hi"),
        "registry": _Registry(),
        "audit": _Audit(),
        "grants": _grants,
    }
    defaults.update(kwargs)
    return await relay_pod_turn(**defaults)


# -- with whose authority ----------------------------------------------------------


async def test_the_pod_is_called_with_a_pkm_read_grant_the_hub_minted():
    pod = _Pod()
    await _turn(session=pod)

    assert pod.calls[0]["headers"]["X-Consent-Token"] == "standing-pkm-read"


async def test_a_caller_supplied_token_is_impossible_by_construction():
    """There is no request field for it. The only token a browser holds is
    `vault.owner` -- the master grant -- so accepting one would let the client
    choose the authority its pod runs under."""
    fields = set(PodTurnRelayRequest.model_fields)
    assert not any("consent" in f or f.endswith("token") for f in fields)


async def test_no_grant_means_no_turn():
    """A pod that cannot be authorized must not be asked to act anyway."""

    async def _broken(_user_id):
        raise RuntimeError("ledger down")

    pod = _Pod()
    with pytest.raises(HTTPException) as exc:
        await _turn(grants=_broken, session=pod)

    assert exc.value.status_code == 503
    assert pod.calls == [], "the pod must never be reached without a grant"


async def test_a_non_owner_is_refused_before_anything_else_happens():
    pod = _Pod()
    with pytest.raises(HTTPException) as exc:
        await _turn(audit=_Audit(denied=True), session=pod)

    assert exc.value.status_code == 403
    assert pod.calls == []


async def test_the_ownership_check_is_audited_against_this_hushh_id():
    audit = _Audit()
    await _turn(audit=audit, session=_Pod())

    assert audit.calls[0]["hushh_id"] == "hushh-abc"
    assert audit.calls[0]["user_id"] == "u1"


# -- where the address comes from --------------------------------------------------


async def test_the_address_comes_only_from_the_row_the_hub_wrote():
    pod = _Pod()
    await _turn(session=pod)
    assert pod.calls[0]["url"] == f"{POD_URL}/api/one/pod/turn"


@pytest.mark.parametrize(
    "metadata",
    [None, {}, {"url": ""}, {"url": "http://evil.example"}, {"url": "ftp://x"}],
)
async def test_a_non_https_or_absent_address_is_never_dialled(metadata):
    """`backend_metadata` is written by our own backend adapter, so anything that is
    not plainly an HTTPS origin means something upstream is wrong -- and the address
    is the one input that decides who we hand a request to."""
    pod = _Pod()
    row = {"user_id": "u1", "status": "connecting", "backend_metadata": metadata}
    with pytest.raises(HTTPException) as exc:
        await _turn(registry=_Registry(row), session=pod)

    assert exc.value.status_code == 409
    assert pod.calls == []


# -- G14: which not-ready is this ---------------------------------------------------


async def test_a_pod_without_an_address_reports_its_real_state():
    """A bare 409 rendered as an opaque error frame during the exact window between
    connecting an AI key and the agent being finished -- when a person is most
    likely to conclude the product is broken."""
    row = {"user_id": "u1", "status": "connecting", "backend_metadata": {}}
    with pytest.raises(HTTPException) as exc:
        await _turn(registry=_Registry(row))

    assert exc.value.detail == {"code": "AGENT_NOT_READY", "status": "connecting"}


async def test_an_unknown_state_still_carries_the_typed_code():
    """The client branches on the code; the status is extra information, never the
    thing that decides whether the UI can explain itself."""
    row = {"user_id": "u1", "backend_metadata": {}}
    with pytest.raises(HTTPException) as exc:
        await _turn(registry=_Registry(row))

    assert exc.value.detail["code"] == "AGENT_NOT_READY"
    assert exc.value.detail["status"] == "unknown"


# -- what comes back ----------------------------------------------------------------


async def test_the_pods_answer_is_returned_to_its_owner():
    result = await _turn(session=_Pod(payload={"text": "hello", "grounded": False}))
    assert result["text"] == "hello"
    assert result["hushhId"] == "hushh-abc"


async def test_the_pods_own_refusal_keeps_its_status():
    """A pod that says "this pod has no model access; connect an AI key first" (400)
    must not reach the person as a 500. Its answer is the useful one."""
    pod = _Pod(status=400, payload={"detail": "this pod has no model access"})
    with pytest.raises(HTTPException) as exc:
        await _turn(session=pod)

    assert exc.value.status_code == 400


async def test_an_unreachable_pod_is_a_503_in_plain_language():
    pod = _Pod(boom=ConnectionError("no route"))
    with pytest.raises(HTTPException) as exc:
        await _turn(session=pod)

    assert exc.value.status_code == 503


# -- the credential ------------------------------------------------------------------


async def test_the_owners_key_reaches_the_pod():
    pod = _Pod()
    await _turn(
        payload=PodTurnRelayRequest(message="hi", runtimeCredential="AIza-owner-key"),
        session=pod,
    )
    assert pod.calls[0]["json"]["runtimeCredential"] == "AIza-owner-key"


async def test_the_key_is_excluded_from_every_serialisation_of_the_request():
    """`exclude=True` is what keeps it out of a request dump reaching a log line.
    The pod needs the value; nothing that writes text about the request does."""
    payload = PodTurnRelayRequest(message="hi", runtimeCredential="AIza-owner-key")

    assert "AIza-owner-key" not in str(payload.model_dump())
    assert "AIza-owner-key" not in payload.model_dump_json()
    # And it is still readable where it is actually needed.
    assert payload.runtime_credential == "AIza-owner-key"


async def test_a_turn_waits_longer_than_a_status_read():
    """A person's question routinely takes tens of seconds. A 5s bound would report
    every genuine answer as "your agent is not answering right now"."""
    pod = _Pod()
    await _turn(session=pod)
    assert pod.calls[0]["timeout"] >= 60


# -- mounted --------------------------------------------------------------------------


def test_the_route_is_reachable():
    from api.routes.one import router as one_router

    paths = {getattr(r, "path", "") for r in one_router.routes}
    assert "/api/one/u/{hushh_id}/turn" in paths


def test_the_relay_path_matches_the_route_the_pod_actually_serves():
    """A mismatch fails only in production, as a 404 the relay would surface as a
    pod fault rather than as our own wrong path."""
    import inspect

    from api.routes.one import pod_turn

    relay_source = inspect.getsource(pod_relay.relay_pod_turn)
    pod_paths = {getattr(r, "path", "") for r in pod_turn.router.routes}

    assert "/api/one/pod/turn" in pod_paths
    assert '"/api/one/pod/turn"' in relay_source


# -- the client half exists ----------------------------------------------------------
#
# The lesson of `/managed/readiness`: a mounted route with no caller is not a
# feature. That surface sat mounted for months with zero callers anywhere in the
# webapp, and it is why the default onboarding path silently never provisioned.


def test_the_webapp_can_actually_call_this():
    from pathlib import Path

    api_service = (
        Path(__file__).resolve().parents[2] / "hushh-webapp" / "lib" / "services" / "api-service.ts"
    ).read_text(encoding="utf-8")

    assert "/api/one/u/" in api_service
    assert "runPodTurn" in api_service


def test_the_client_never_sends_a_consent_token():
    """The browser holds the vault-owner MASTER grant. If the client attached a
    token, that is the one it would have to attach -- handing the pod everything
    its person has, in the one request where least privilege matters most."""
    import re
    from pathlib import Path

    api_service = (
        Path(__file__).resolve().parents[2] / "hushh-webapp" / "lib" / "services" / "api-service.ts"
    ).read_text(encoding="utf-8")
    body = re.search(r"static async runPodTurn\(.*?\n  \}\n", api_service, re.S)
    assert body, "runPodTurn not found"
    assert "X-Consent-Token" not in body.group(0)
    assert "vaultOwnerToken" not in body.group(0)


def test_the_client_surfaces_the_typed_not_ready_state():
    """So the UI can say "starting up" rather than "something went wrong" during
    the window when a person is most likely to assume the product is broken."""
    from pathlib import Path

    api_service = (
        Path(__file__).resolve().parents[2] / "hushh-webapp" / "lib" / "services" / "api-service.ts"
    ).read_text(encoding="utf-8")

    assert "AGENT_NOT_READY" in api_service
