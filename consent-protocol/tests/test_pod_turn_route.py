"""The pod turn route — the first time a pod runs Agent One.

The properties that matter are the refusals, not the happy path:

  * an unverifiable consent token REFUSES rather than running the turn ungated. A
    pod's signing key is deliberately different from the hub's, so while issuance is
    HMAC a pod cannot verify anything — and "cannot verify" must never degrade into
    "proceed anyway", which would be a consent bypass in the one place the protocol
    exists to protect.
  * the answer always reports `grounded: false`. A pod has no durable key and no
    populated store yet, so it knows nothing about its owner. Letting a caller
    assume otherwise would repeat the exact failure of the hardcoded /health roster.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="t"` is a test fixture for an argument that is
# genuinely named consent_token; no real credential appears in this file.
import pytest
from fastapi import HTTPException

from api.routes.one import pod_turn
from api.routes.one.pod_turn import PodTurnRequest


class _Event:
    def __init__(self, kind: str, text: str = "", directive=None) -> None:
        self.kind = kind
        self.text = text
        self.directive = directive


def _stream(events, *, boom: Exception | None = None):
    async def _run(**_kwargs):
        if boom is not None:
            raise boom
        for event in events:
            yield event

    return _run


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda: ("gemini", "gemini-test"))


def _consent_ok(monkeypatch, user_id="u1"):
    # NOTE: this stubs `_validate_consent` wholesale, so it bypasses the owner
    # binding by construction. The binding itself is tested below against the real
    # function with a stubbed verifier.
    # `verifier` is the injectable seam the turn route threads to the consent
    # authority client; a stub without it diverges from the real call site.
    async def _validate(_token, *, verifier=None):
        return {"user_id": user_id, "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)


def _payload(message="hello", **kw):
    # A pod serves turns on the OWNER'S key. Every normal turn carries one; the
    # tests that omit it are asserting the refusal, not taking a shortcut.
    kw.setdefault("runtime_credential", "owner-key")
    return PodTurnRequest(message=message, **kw)


# -- the refusals --------------------------------------------------------------


async def test_the_route_is_absent_while_the_flag_is_off(monkeypatch):
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: False)
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), consent_token="t")
    assert exc.value.status_code == 404


async def test_the_route_is_absent_on_the_hub(monkeypatch):
    """The hub already has a turn route. A second implementation of the same
    contract is free to drift from it, so on the hub this must not exist."""
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: False)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), consent_token="t")
    assert exc.value.status_code == 404


async def test_no_consent_token_is_401(enabled):
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), consent_token="")
    assert exc.value.status_code == 401


async def test_an_unverifiable_token_refuses_and_never_runs_the_turn(enabled, monkeypatch):
    """While issuance is HMAC a pod cannot verify at all. It must refuse, not run."""
    ran = {"yes": False}

    async def _run(**_kwargs):
        ran["yes"] = True
        yield _Event("token", "should never happen")

    async def _reject(_token, *, verifier=None):
        raise HTTPException(status_code=403, detail="consent token is not valid here")

    monkeypatch.setattr(pod_turn, "_validate_consent", _reject)

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), consent_token="hmac-token", stream_fn=_run)

    assert exc.value.status_code == 403
    assert ran["yes"] is False


async def test_a_token_with_no_owner_is_refused(enabled, monkeypatch):
    async def _validate(_token, *, verifier=None):
        return {"user_id": "", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), consent_token="t")
    assert exc.value.status_code == 403


# -- the turn ------------------------------------------------------------------


async def test_a_verified_turn_returns_the_model_text(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    events = [_Event("token", "Hello "), _Event("token", "world."), _Event("thought", "ignored")]

    result = await pod_turn.run_pod_turn(
        payload=_payload(), consent_token="t", stream_fn=_stream(events)
    )

    assert result["text"] == "Hello world."
    assert result["model"] == "gemini-test"


async def test_the_answer_always_says_it_is_ungrounded(enabled, monkeypatch):
    """A pod has no durable key and no populated store. Implying otherwise here
    would repeat the hardcoded-health-roster failure exactly."""
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(), consent_token="t", stream_fn=_stream([_Event("token", "hi")])
    )
    assert result["grounded"] is False


async def test_the_owner_is_taken_from_the_token_never_the_request(enabled, monkeypatch):
    """There is no user_id field on the request, and there must never be one."""
    _consent_ok(monkeypatch, user_id="owner-from-token")
    seen: dict = {}

    async def _run(**kwargs):
        seen.update(kwargs)
        yield _Event("token", "ok")

    await pod_turn.run_pod_turn(payload=_payload(), consent_token="t", stream_fn=_run)

    assert seen["user_id"] == "owner-from-token"
    assert "user_id" not in PodTurnRequest.model_fields


async def test_no_pkm_context_is_passed(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    seen: dict = {}

    async def _run(**kwargs):
        seen.update(kwargs)
        yield _Event("token", "ok")

    await pod_turn.run_pod_turn(payload=_payload(), consent_token="t", stream_fn=_run)
    assert seen["pkm_context"] is None


async def test_directives_are_counted(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    events = [_Event("token", "sure"), _Event("directive", directive={"action": "open"})]
    result = await pod_turn.run_pod_turn(
        payload=_payload(), consent_token="t", stream_fn=_stream(events)
    )
    assert result["directiveCount"] == 1


async def test_a_failed_turn_is_502_not_a_raw_traceback(enabled, monkeypatch):
    """A 500 both leaks internals and invites the caller to treat it as permanent."""
    _consent_ok(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=_payload(),
            consent_token="t",
            stream_fn=_stream([], boom=RuntimeError("model exploded")),
        )
    assert exc.value.status_code == 502
    # The exception TYPE is useful; its message may carry internals, so it is not echoed.
    assert "model exploded" not in str(exc.value.detail)


def test_the_route_is_mounted_in_the_pod():
    """A turn route nobody mounted is a pod that still runs no agent."""
    import pod_server

    paths = {getattr(r, "path", "") for r in pod_server.app.routes}
    assert "/api/one/pod/turn" in paths


# -- whose model answers -------------------------------------------------------


async def test_a_turn_runs_on_the_owners_key(enabled, monkeypatch):
    """ "Own your AI" is a cost boundary, not a slogan: the person's key, their
    quota, their spend."""
    _consent_ok(monkeypatch)
    seen: dict = {}

    async def _run(**kwargs):
        seen.update(kwargs)
        yield _Event("token", "ok")

    result = await pod_turn.run_pod_turn(payload=_payload(), consent_token="t", stream_fn=_run)

    assert seen["runtime_credential"] == "owner-key"
    assert result["runtimeMode"] == "byok"


def test_the_runtime_mode_is_one_the_model_builder_actually_accepts():
    """The two ends of this handoff must speak one vocabulary.

    This route returned `"gemini_byok"` while `text_runtime._runtime_model`
    branches on `"byok"`, so a pod turn carrying a credential matched neither BYOK
    branch and raised. The BYOK pod path failed on every turn, and no test saw it
    because the route test above injects a stub `stream_fn` — it asserts the
    string this function returns, never what the next function does with it.

    So this asserts the AGREEMENT rather than either value: whatever
    `_resolve_runtime_mode` produces must be a member of the canonical mode set
    the builder dispatches on. Restating the expected literal here would just be a
    third copy to drift.
    """
    from typing import get_args

    from hushh_mcp.services.agent_chat_service import AgentRuntimeCredentialMode

    accepted = set(get_args(AgentRuntimeCredentialMode))

    byok = pod_turn._resolve_runtime_mode(_payload())
    assert byok in accepted, f"{byok!r} is not a mode the model builder can dispatch on"


async def test_no_key_and_no_managed_fallback_is_a_clear_400(enabled, monkeypatch):
    """A pod that silently reached for a fleet identity would spend money nobody
    authorised -- and by the provisioning gate, a keyless user has no pod at all."""
    _consent_ok(monkeypatch)
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "pod_managed_model_enabled", lambda: False)

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=_payload(runtime_credential=None),
            consent_token="t",
            stream_fn=_stream([_Event("token", "hi")]),
        )
    assert exc.value.status_code == 400
    assert "AI key" in str(exc.value.detail)


async def test_the_managed_fallback_is_only_reached_when_explicitly_enabled(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "pod_managed_model_enabled", lambda: True)

    result = await pod_turn.run_pod_turn(
        payload=_payload(runtime_credential=None),
        consent_token="t",
        stream_fn=_stream([_Event("token", "hi")]),
    )
    assert result["runtimeMode"] == "hushh_managed_vertex"


async def test_the_owners_key_is_never_echoed_back(enabled, monkeypatch):
    """It arrives with the turn and leaves with it. Nothing stores or returns it."""
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(runtime_credential="super-secret-key"),
        consent_token="t",
        stream_fn=_stream([_Event("token", "hi")]),
    )
    assert "super-secret-key" not in str(result)


# -- whose turn is this --------------------------------------------------------
#
# A valid token proves someone consented. It does NOT prove they own THIS pod.
# Without the binding, person A's token presented to person B's pod would drive
# B's pod on A's behalf: B's memory, B's holdings, B's model spend.


def _verdict(**kw):
    from hushh_mcp.services.pod_consent_client import ConsentVerdict

    base = {"valid": True, "available": True, "user_id": "u1", "hushh_id": "hushh-mine"}
    base.update(kw)
    return ConsentVerdict(**base)


async def test_a_turn_for_this_pods_owner_is_allowed(enabled, monkeypatch):
    monkeypatch.setenv("HUSSH_ID", "hushh-mine")

    async def _v(_token, expected_scope=""):
        return _verdict()

    result = await pod_turn.run_pod_turn(
        payload=_payload(),
        consent_token="t",
        verifier=_v,
        stream_fn=_stream([_Event("token", "hi")]),
    )
    assert result["text"] == "hi"


async def test_another_owners_valid_token_is_refused(enabled, monkeypatch):
    """The finding this closes: valid != yours."""
    monkeypatch.setenv("HUSSH_ID", "hushh-mine")
    ran = {"yes": False}

    async def _v(_token, expected_scope=""):
        return _verdict(hushh_id="hushh-someone-else")

    async def _run(**_kwargs):
        ran["yes"] = True
        yield _Event("token", "should never happen")

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=_payload(), consent_token="t", verifier=_v, stream_fn=_run
        )
    assert exc.value.status_code == 403
    assert ran["yes"] is False
    # Same shape as any denial -- a caller must not learn it was somebody else's.
    assert "not valid here" in str(exc.value.detail)


async def test_an_unresolvable_owner_binding_is_refused(enabled, monkeypatch):
    """Empty must never read as "any pod will do"."""
    monkeypatch.setenv("HUSSH_ID", "hushh-mine")

    async def _v(_token, expected_scope=""):
        return _verdict(hushh_id="")

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), consent_token="t", verifier=_v)
    assert exc.value.status_code == 403


async def test_a_pod_with_no_identity_of_its_own_refuses(enabled, monkeypatch):
    monkeypatch.delenv("HUSSH_ID", raising=False)

    async def _v(_token, expected_scope=""):
        return _verdict()

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), consent_token="t", verifier=_v)
    assert exc.value.status_code == 403


def test_the_credential_bound_matches_the_hubs():
    """A tighter cap here would 422 credentials the hub accepts, surfacing through
    the relay as an opaque refusal rather than an actionable message."""
    from api.routes.kai.agent_chat import AgentChatStreamRequest

    pod_max = PodTurnRequest.model_fields["runtime_credential"].metadata
    hub_max = AgentChatStreamRequest.model_fields["runtime_credential"].metadata
    assert str(pod_max) == str(hub_max)
