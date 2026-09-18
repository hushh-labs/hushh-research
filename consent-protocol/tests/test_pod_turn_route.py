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


def test_puppy_target_uses_owner_device_admission_not_global_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PUPPY_INFERENCE_ENABLED", raising=False)
    payload = PodTurnRequest(
        message="hello",
        runtime_provider="puppy",
        puppy_device_id="device-1",
    )

    assert pod_turn._resolve_model(payload) == ("puppy", "local")


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


async def test_a_failed_turn_is_502_not_a_raw_traceback(enabled, monkeypatch, caplog):
    """A 500 both leaks internals and invites the caller to treat it as permanent."""
    _consent_ok(monkeypatch)
    import traceback

    private_text = " ".join(("credential-sentinel", "projection-sentinel", "storage-path-sentinel"))
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=_payload(),
            consent_token="t",
            stream_fn=_stream([], boom=RuntimeError(private_text)),
        )
    assert exc.value.status_code == 502
    # The exception TYPE is useful; its message may carry internals, so it is not echoed.
    assert exc.value.detail == "the agent could not complete this turn: RuntimeError"
    rendered = "".join(traceback.format_exception(exc.value))
    for sentinel in private_text.split():
        assert sentinel not in str(exc.value.detail)
        assert sentinel not in caplog.text
        assert sentinel not in rendered
    assert all(record.exc_info is None for record in caplog.records)


# -- the keyless-pod DB wall degrades, never 502s ------------------------------
# A pod holds no DB credential by design. A tool that reaches for the DB (calendar,
# any connected-account read) raises "Database credentials not set". That is the pod
# being a pod, so the owner must see "I can't do that here yet", not their agent
# crashing. Observed live 2026-09-01: "set a reminder" 502'd a healthy user_adc pod.


class _FakeDatabaseExecutionError(Exception):
    """Stands in for db.db_client.DatabaseExecutionError. The boundary matches on the
    MESSAGE (the pod image need not import the db layer), so only the text matters."""


def _db_wall_error() -> Exception:
    return _FakeDatabaseExecutionError(
        "DB operation failed [<raw_sql>.execute_raw]: Database credentials not set. "
        "Required: DB_USER, DB_PASSWORD, and one of DB_HOST/DB_UNIX_SOCKET."
    )


async def test_the_keyless_pod_db_wall_degrades_gracefully_not_502(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(),
        consent_token="t",
        stream_fn=_stream([], boom=_db_wall_error()),
    )
    # A dict, not a raised 502.
    assert result["degraded"] == "keyless_pod_db_wall"
    assert result["directiveCount"] == 0
    assert result["directives"] == []
    assert result["text"]  # an honest, non-empty message for the owner
    assert "traceback" not in result["text"].lower()


async def test_a_db_wall_wrapped_in_a_cause_chain_still_degrades(enabled, monkeypatch, caplog):
    # The DB error is raised deep in a tool and re-wrapped by the ADK runner before
    # it reaches the turn boundary, so detection must walk the cause chain.
    _consent_ok(monkeypatch)
    caplog.set_level("INFO")
    outer = RuntimeError("private-outer-error-sentinel")
    outer.__cause__ = _db_wall_error()
    result = await pod_turn.run_pod_turn(
        payload=_payload(),
        consent_token="t",
        stream_fn=_stream([], boom=outer),
    )
    assert result["degraded"] == "keyless_pod_db_wall"
    assert "private-outer-error-sentinel" not in caplog.text
    assert "DB_PASSWORD" not in caplog.text


def test_the_db_wall_detector_is_narrow():
    # Detects the credential wall, by type name + message and through a cause chain.
    assert pod_turn._is_keyless_pod_db_wall(_db_wall_error()) is True
    assert (
        pod_turn._is_keyless_pod_db_wall(
            OSError("Database credentials not set. Required: DB_USER, DB_PASSWORD")
        )
        is True
    )
    wrapped = RuntimeError("wrapped")
    wrapped.__context__ = _db_wall_error()
    assert pod_turn._is_keyless_pod_db_wall(wrapped) is True
    # Rejects a real turn failure -- masking that would hide a genuine bug behind a
    # cheerful "I can't do that here yet".
    assert pod_turn._is_keyless_pod_db_wall(RuntimeError("model exploded")) is False
    # Rejects a DatabaseExecutionError that is NOT the credential wall: a real DB
    # fault (a deadlock, a timeout) must still surface, never be degraded.
    assert (
        pod_turn._is_keyless_pod_db_wall(_FakeDatabaseExecutionError("deadlock detected")) is False
    )


def test_the_route_is_mounted_in_the_pod(monkeypatch):
    """A turn route nobody mounted is a pod that still runs no agent."""
    # pod_server sets this process environment at import. Restore it after the
    # mount check so subsequent shared-runtime tests retain their topology.
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
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
    the relay as an opaque refusal rather than an actionable message.

    The relay's ``PodTurnRelayRequest`` is the hub-side door that forwards the
    owner's key to the pod (the pre-refactor ``kai.agent_chat`` model that used to
    anchor this bound was removed on main), so its cap is the one the pod must match.
    """
    from api.routes.one.pod_relay import PodTurnRelayRequest

    pod_max = PodTurnRequest.model_fields["runtime_credential"].metadata
    hub_max = PodTurnRelayRequest.model_fields["runtime_credential"].metadata
    assert str(pod_max) == str(hub_max)


async def test_pod_ingress_runs_shared_location_loop_and_recovers_history(tmp_path, monkeypatch):
    """Real ingress/dispatch/tool/store; only authority and model transports are synthetic."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from google.genai import types

    from hushh_mcp.adk_bridge import _register_builtin_specialists
    from hushh_mcp.adk_bridge.dispatch import specialist_runtime_bound
    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services import pod_consent_client, pod_memory_service
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
    from hushh_mcp.services.pod_consent_client import ConsentVerdict

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_POD_TURN_ENABLED", "1")
    monkeypatch.setenv("HUSSH_ID", "pod-synthetic")
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda: ("gemini", "synthetic-model"))
    _register_builtin_specialists()
    scopes = []

    async def verify(token, *, expected_scope):
        scopes.append(expected_scope)
        scoped = {
            "read": "pkm.read",
            "invoke": "cap.one.invoke",
            "share": "cap.location.live.share",
        }
        return ConsentVerdict(
            token in scoped and scoped[token] == expected_scope,
            True,
            "owner",
            "pod-synthetic",
            scoped.get(token, ""),
        )

    monkeypatch.setattr(pod_consent_client, "verify_consent", verify)
    # A fresh log instance on each turn proves reconstruction, not warm cache reuse.
    monkeypatch.setattr(
        pod_memory_service,
        "_resolve_log",
        lambda: PodCommitLog(LocalObjectStore(str(tmp_path)), b"k" * 32, owner_id="pod-synthetic"),
    )
    responses = iter(
        [
            SimpleNamespace(
                function_calls=[
                    SimpleNamespace(name="propose_public_link", args={"duration_hours": 0.5})
                ],
                text="",
                candidates=[
                    SimpleNamespace(
                        content=types.Content(role="model", parts=[types.Part(text="")])
                    )
                ],
            ),
            SimpleNamespace(function_calls=[], text="Confirm the proposed link.", candidates=[]),
            SimpleNamespace(
                function_calls=[], text="We proposed a thirty-minute link.", candidates=[]
            ),
        ]
    )
    contents_seen = []

    async def generate(*, model, contents, config):
        assert model == "synthetic-model"
        contents_seen.append([part.text for item in contents for part in item.parts if part.text])
        return next(responses)

    client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
    monkeypatch.setattr(factory, "build_runtime_client", lambda *a, **kw: client)
    # Neither the old summary nor a shared conversation/provider service may serve this turn.
    from hushh_mcp.one_adk import pod_data_door_specialist

    monkeypatch.setattr(
        pod_data_door_specialist,
        "serve_specialist_via_data_door",
        AsyncMock(side_effect=AssertionError("summary bypass")),
    )
    captured = []

    async def run(**kwargs):
        context = SimpleNamespace(
            state={
                agent_tree.STATE_USER_ID: kwargs["user_id"],
                agent_tree.STATE_CONSENT_TOKEN: kwargs["consent_token"],
                agent_tree.STATE_CONVERSATION_ID: kwargs["conversation_id"],
                agent_tree.STATE_DATA_DOOR_GRANTS: kwargs["data_door_grants"],
            }
        )
        result = await agent_tree._specialist_turn("agent_location", kwargs["message"], context)
        captured.append((result, context.state[agent_tree.STATE_CONVERSATION_ID]))
        yield _Event("token", result.get("text", result.get("message", "failed")))

    first = await pod_turn.run_pod_turn(
        payload=_payload(
            "Propose a public link",
            pkm_context="synthetic grounding",
            data_door_grants={"invoke": "invoke", "cap.location.live.share": "share"},
        ),
        consent_token="read",
        stream_fn=run,
    )
    assert first["text"] == "Confirm the proposed link."
    assert captured[0][0]["status"] == "ok"
    assert "cap.location.live.share" in scopes
    assert not specialist_runtime_bound()
    second = await pod_turn.run_pod_turn(
        payload=_payload(
            "What did we propose?",
            # Actual caller behavior: reuse the hub/browser's original root id.
            conversation_id="pod-first-light",
            pkm_context="synthetic grounding",
            data_door_grants={"invoke": "invoke", "cap.location.live.share": "share"},
        ),
        consent_token="read",
        stream_fn=run,
    )
    assert second["text"] == "We proposed a thirty-minute link."
    assert "Propose a public link" in contents_seen[-1]
    assert "Confirm the proposed link." in contents_seen[-1]
    assert not specialist_runtime_bound()


# -- Lane B1: a capability the owner's device model lacks is refused, named, and
# never a 502. The device answered; the request asked for something it cannot do.


def _capability_refusal() -> Exception:
    from hushh_mcp.runtime_providers.puppy_transport import PuppyCapabilityUnsupported

    return PuppyCapabilityUnsupported("json_schema")


async def test_a_root_level_capability_refusal_is_200_degraded_not_502(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(),
        consent_token="t",
        stream_fn=_stream([], boom=_capability_refusal()),
    )
    assert result["degraded"] == "puppy_capability_unsupported"
    assert result["modelReported"] is False
    assert result["directives"] == [] and result["specialists"] == []
    assert result["text"]
    assert "traceback" not in result["text"].lower()


async def test_a_capability_refusal_wrapped_by_the_runner_still_degrades(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    wrapped = RuntimeError("runner wrapper")
    wrapped.__cause__ = _capability_refusal()
    result = await pod_turn.run_pod_turn(
        payload=_payload(), consent_token="t", stream_fn=_stream([], boom=wrapped)
    )
    assert result["degraded"] == "puppy_capability_unsupported"


async def test_an_ordinary_failure_is_still_a_502_negative_control(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=_payload(),
            consent_token="t",
            stream_fn=_stream([], boom=RuntimeError("model exploded")),
        )
    assert exc.value.status_code == 502


async def test_a_specialist_capability_refusal_is_named_unsupported(tmp_path, monkeypatch):
    """The same refusal from a specialist's model call reaches One as an
    `unsupported` outcome, not as the generic `specialist_runtime_failed`."""
    from types import SimpleNamespace

    from hushh_mcp.adk_bridge import _register_builtin_specialists
    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.services import pod_consent_client
    from hushh_mcp.services.pod_consent_client import ConsentVerdict
    from hushh_mcp.services.pod_specialist_runtime import PodSpecialistCapabilityUnsupported

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_ID", "pod-synthetic")
    _register_builtin_specialists()

    async def verify(token, *, expected_scope):
        scoped = {"read": "pkm.read", "invoke": "cap.one.invoke"}
        return ConsentVerdict(
            token in scoped and scoped[token] == expected_scope,
            True,
            "owner",
            "pod-synthetic",
            scoped.get(token, ""),
        )

    monkeypatch.setattr(pod_consent_client, "verify_consent", verify)

    async def refusing_dispatch(agent_id, task):
        raise PodSpecialistCapabilityUnsupported("json_schema")

    monkeypatch.setattr(agent_tree, "dispatch", refusing_dispatch)
    context = SimpleNamespace(
        state={
            agent_tree.STATE_USER_ID: "owner",
            agent_tree.STATE_CONSENT_TOKEN: "read",
            agent_tree.STATE_CONVERSATION_ID: "c1",
            agent_tree.STATE_DATA_DOOR_GRANTS: {"invoke": "invoke"},
        }
    )
    result = await agent_tree._specialist_turn("agent_location", "Propose a link", context)
    assert result["status"] == "unsupported"
    assert result["reason"] == "provider_capability_unsupported"
    assert result["capability"] == "json_schema"
    assert result["availability"]["specialist_id"] == "agent_location"


# -- Lane B2: the model named in the response is the one that answered, or it says so


class _ReportedEvent(_Event):
    def __init__(self, text: str, model_version: str) -> None:
        super().__init__("token", text)
        self.model_version = model_version


async def test_a_reported_model_is_named_and_flagged_reported(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(),
        consent_token="t",
        stream_fn=_stream([_ReportedEvent("hi", "qwen3-30b-a3b-mlx")]),
    )
    assert result["model"] == "qwen3-30b-a3b-mlx"
    assert result["modelReported"] is True


async def test_an_unreported_model_falls_back_to_the_resolved_id_and_says_so(enabled, monkeypatch):
    """`local` was reported as THE model on every Puppy turn. Now it is only the
    resolved id, and `modelReported: false` says nothing confirmed it."""
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(), consent_token="t", stream_fn=_stream([_Event("token", "hi")])
    )
    assert result["model"] == "gemini-test"
    assert result["modelReported"] is False


async def test_the_first_reported_model_wins_and_blank_reports_do_not_count(enabled, monkeypatch):
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(),
        consent_token="t",
        stream_fn=_stream(
            [_ReportedEvent("a", ""), _ReportedEvent("b", "first"), _ReportedEvent("c", "second")]
        ),
    )
    assert result["model"] == "first"
    assert result["modelReported"] is True


# -- Lane B5: the text path enforces the same grant allowlist the Live path does --


def _turn_app():
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(pod_turn.router)
    return app


def test_an_unknown_grant_key_is_422_before_the_turn_runs(monkeypatch):
    from fastapi.testclient import TestClient

    async def never(**_kwargs):
        pytest.fail("the turn ran with an unknown grant key")

    monkeypatch.setattr(pod_turn, "run_pod_turn", never)
    response = TestClient(_turn_app()).post(
        "/api/one/pod/turn",
        json={"message": "hi", "dataDoorGrants": {"vault.owner": "master-grant"}},
        headers={"X-Consent-Token": "t"},
    )
    assert response.status_code == 422
    assert "unknown grant key" in response.text


def test_an_oversized_grant_value_is_422(monkeypatch):
    from fastapi.testclient import TestClient

    response = TestClient(_turn_app()).post(
        "/api/one/pod/turn",
        json={"message": "hi", "dataDoorGrants": {"location": "x" * 4097}},
        headers={"X-Consent-Token": "t"},
    )
    assert response.status_code == 422
    assert "too long" in response.text


def test_every_couriered_grant_key_is_admitted():
    from api.routes.one.pod_relay import POD_DATA_DOOR_NAMES

    grants = {key: "x" * 4096 for key in pod_turn.POD_TURN_GRANT_KEYS}
    assert PodTurnRequest(message="hi", dataDoorGrants=grants).data_door_grants == grants
    assert set(POD_DATA_DOOR_NAMES) < set(pod_turn.POD_TURN_GRANT_KEYS)
    assert {"cap.location.live.share", "cap.location.live.refer_request"} < set(
        pod_turn.POD_TURN_GRANT_KEYS
    )


def test_the_grant_bound_matches_the_live_routes_header_bound():
    """The Live route refuses a door header over 4096 bytes; the text path must
    not admit a longer one or the two transports disagree about what fits."""
    from pathlib import Path

    src = Path(pod_turn.__file__).read_text(encoding="utf-8")
    assert "_MAX_GRANT_TOKEN_LENGTH = 4096" in src
    assert "len(token) > 4096" in src, "the Live header bound moved; keep the two aligned"


# -- observed recall on the response ------------------------------------------------


async def test_a_recall_turn_with_empty_history_reports_the_observed_load_memory_call(
    enabled, monkeypatch
):
    """K9's evidence shape. The north star credits recall only as an OBSERVED
    `load_memory` call; the turn response now carries it beside `specialists` as
    `memory.recalls`, read off the runner's memory event, never off the answer text.
    `history: []` is the point: a recall from an EMPTY browser history can only have
    come from the pod's own memory."""
    _consent_ok(monkeypatch)
    seen: dict = {}

    async def _run(**kwargs):
        seen.update(kwargs)
        yield _Event("token", "Pushkin, your dachshund.")
        event = _Event("memory")
        event.memory = {
            "enabled": True,
            "recalls": [{"queryChars": 9, "hits": 1, "backend": "commit_log"}],
            "review": {"outcome": "nothing_to_review", "reason": "catch_up"},
            "written": 2,
            "provider": {"consent": "absent", "generate": "no_bank", "recall": "no_bank"},
        }
        yield event

    result = await pod_turn.run_pod_turn(
        payload=_payload("what is my dog called?", history=[]),
        consent_token="t",
        stream_fn=_run,
    )
    assert list(seen["history"]) == []
    assert result["text"] == "Pushkin, your dachshund."
    memory = result["memory"]
    assert memory["recalls"] == [{"queryChars": 9, "hits": 1, "backend": "commit_log"}]
    assert memory["written"] == 2
    assert memory["provider"]["consent"] == "absent"
    assert memory["review"]["outcome"] == "nothing_to_review"
    # Shape only: no query text, no answer text, no record content anywhere in it.
    assert "Pushkin" not in str(memory)
    assert "dog" not in str(memory)


async def test_a_pre_join_runner_returns_no_memory_key(enabled, monkeypatch):
    """An older image emits no memory event; the response must not invent one, so
    the drill's `memory_join_present_on_image` precondition reads its absence."""
    _consent_ok(monkeypatch)
    result = await pod_turn.run_pod_turn(
        payload=_payload(), consent_token="t", stream_fn=_stream([_Event("token", "hi")])
    )
    assert "memory" not in result
    assert "specialists" in result


# -- owner-local sessions (Lane A) ---------------------------------------------------
#
# A turn admitted by the pod's own authority never asks the hub. These build a real
# authority over a real log so the refusals are the authority's, not a stub's.


@pytest.fixture
async def local_authority(tmp_path, monkeypatch):
    import base64
    import json
    import time

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from hushh_mcp.consent import token_signing
    from hushh_mcp.services import pod_authority_store as store_module
    from hushh_mcp.services import pod_session_authority as psa
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    hub = Ed25519PrivateKey.generate()
    seed = hub.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    public = hub.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    monkeypatch.setenv("CONSENT_ED25519_PRIVATE_KEY", base64.b64encode(seed).decode())
    monkeypatch.setenv("CONSENT_ED25519_KID", "kid-turn")
    monkeypatch.setenv(
        "CONSENT_ED25519_PUBLIC_KEYS", json.dumps({"kid-turn": base64.b64encode(public).decode()})
    )
    token_signing.reset_caches()
    monkeypatch.setenv("HUSSH_ID", "ha1_turn_owner")
    # The session door checks pod mode itself (api/routes/one/pod_session.py); set it
    # explicitly so this fixture does not depend on pod_server having been imported
    # earlier in the same process.
    monkeypatch.setenv("HUSSH_POD_MODE", "1")

    object_store = LocalObjectStore(str(tmp_path / "pod"))
    log = PodCommitLog(object_store, b"T" * 32, owner_id="ha1_turn_owner")
    incarnation = await store_module.claim_incarnation(object_store, b"T" * 32, instance_id="a")
    store = store_module.PodAuthorityStore(log, hushh_id="ha1_turn_owner")
    await store.load()
    authority = psa.PodSessionAuthority(
        store=store,
        lease=store_module.IncarnationLease(object_store, incarnation),
        dek=b"T" * 32,
        pod_key_id="podk_turn",
        pod_public_key=base64.b64encode(b"K" * 32).decode(),
        environment="dev",
    )
    store_module.set_active_authority_store(store)
    psa.set_active_session_authority(authority)

    class Subject:
        def __init__(self, subject_id, platform):
            self.subject_id, self.platform = subject_id, platform
            self._key = ec.generate_private_key(ec.SECP256R1())
            self.public_key_b64 = base64.b64encode(
                self._key.public_key().public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
                )
            ).decode()

        def sign(self, payload):
            return base64.b64encode(
                self._key.sign(payload.encode(), ec.ECDSA(hashes.SHA256()))
            ).decode()

    async def admit(subject_id, platform, *, version=1, scopes=None):
        subject = Subject(subject_id, platform)
        role = psa.role_for_platform(platform)
        now = int(time.time() * 1000)
        binding = {
            "kind": psa.BINDING_KIND,
            "hushh_id": "ha1_turn_owner",
            "user_id": "uid-turn",
            "environment": "dev",
            "pod_key_id": "podk_turn",
            "pod_public_key": base64.b64encode(b"K" * 32).decode(),
            "url": "https://pod.example",
            "subject_id": subject_id,
            "subject_kind": role,
            "subject_public_key": subject.public_key_b64,
            "platform": platform,
            "role": role,
            "scopes": list(
                scopes
                if scopes is not None
                else (psa.APP_SCOPES if role == "app" else psa.DEVICE_INFERENCE_SCOPES)
            ),
            "version": version,
            "issued_at_ms": now,
            "expires_at_ms": now + 86_400_000,
        }
        signature = token_signing.sign_payload(
            psa.canonical_json(binding), hmac_key="x", require_asymmetric=True
        )
        challenge = authority.create_challenge(subject_id)
        return await authority.admit(
            binding=binding,
            signature=signature,
            challenge_id=challenge["challenge_id"],
            nonce=challenge["nonce"],
            proof=subject.sign(challenge["signing_payload"]),
            epoch=authority.epoch,
        )

    yield {"authority": authority, "admit": admit, "store": store}
    psa.set_active_session_authority(None)
    store_module.set_active_authority_store(None)
    token_signing.reset_caches()


def _local_turn_kwargs(authority, claims, **extra):
    return {
        "consent_token": authority.local_token(claims),
        "verifier": authority.local_verifier(claims),
        "session": claims,
        **extra,
    }


async def test_a_local_session_runs_a_turn_without_asking_the_hub(
    enabled, monkeypatch, local_authority
):
    from hushh_mcp.services import pod_consent_client

    async def _never(*_a, **_k):
        raise AssertionError("the hub was asked on an owner-local turn")

    monkeypatch.setattr(pod_consent_client, "verify_consent", _never)
    authority = local_authority["authority"]
    _, claims = await local_authority["admit"]("tdv_app_1", "web")
    seen = {}

    async def _run(**kwargs):
        seen.update(kwargs)
        yield _Event("token", "local answer")

    result = await pod_turn.run_pod_turn(
        payload=_payload(), stream_fn=_run, **_local_turn_kwargs(authority, claims)
    )

    assert result["text"] == "local answer"
    assert seen["user_id"] == "uid-turn"
    assert seen["session_owner_id"] == "ha1_turn_owner"
    assert seen["consent_token"].startswith("pod-session:")


async def test_a_device_role_session_cannot_run_a_turn(enabled, local_authority):
    authority = local_authority["authority"]
    _, claims = await local_authority["admit"]("tdv_mac_1", "macos")
    ran = {"yes": False}

    async def _run(**_kwargs):
        ran["yes"] = True
        yield _Event("token", "never")

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=_payload(), stream_fn=_run, **_local_turn_kwargs(authority, claims)
        )
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "role_mismatch"
    assert ran["yes"] is False


async def test_a_revoked_subject_is_refused_before_the_runner(enabled, local_authority):
    authority = local_authority["authority"]
    _, claims = await local_authority["admit"]("tdv_app_1", "web")
    kwargs = _local_turn_kwargs(authority, claims)
    await authority.revoke_subject("tdv_app_1", reason="owner_revoked")
    ran = {"yes": False}

    async def _run(**_kwargs):
        ran["yes"] = True
        yield _Event("token", "never")

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=_payload(), stream_fn=_run, **kwargs)
    assert exc.value.status_code == 403
    assert ran["yes"] is False


async def test_a_hub_token_on_the_local_path_is_refused_by_shape(enabled, local_authority):
    hct = "HCT:" + "eyJ1IjoxfQ" + ".deadbeef"
    with pytest.raises(HTTPException) as exc:
        await pod_turn.pod_turn_route(
            payload=_payload(), x_consent_token=None, authorization=f"Bearer {hct}"
        )
    assert exc.value.status_code == 401
    assert exc.value.detail["code"] == "not_local_authority"


async def test_the_route_opens_the_local_door_on_a_pod_session_bearer(
    enabled, monkeypatch, local_authority
):
    token, _claims = await local_authority["admit"]("tdv_app_1", "web")
    seen = {}

    async def _run_core(**kwargs):
        seen.update(kwargs)
        return {"text": "ok"}

    monkeypatch.setattr(pod_turn, "run_pod_turn", _run_core)
    result = await pod_turn.pod_turn_route(
        payload=_payload(), x_consent_token=None, authorization=f"Bearer {token}"
    )
    assert result == {"text": "ok"}
    assert seen["session"]["subject_id"] == "tdv_app_1"
    assert seen["consent_token"].startswith("pod-session:")


async def test_a_local_puppy_turn_needs_an_enrolled_and_linked_device(
    enabled, monkeypatch, local_authority
):
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda payload=None: ("puppy", "local"))
    authority = local_authority["authority"]
    _, claims = await local_authority["admit"]("tdv_app_1", "web")
    kwargs = _local_turn_kwargs(authority, claims)
    payload = PodTurnRequest(message="hi", runtime_provider="puppy", puppy_device_id="tdv_mac_1")
    seen = {}

    async def _run(**run_kwargs):
        seen.update(run_kwargs)
        yield _Event("token", "from puppy")

    # Not enrolled at all.
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=payload, stream_fn=_run, **kwargs)
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "PUPPY_OFFLINE"

    # Enrolled without the inference scope.
    await local_authority["admit"]("tdv_mac_1", "macos", scopes=[])
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=payload, stream_fn=_run, **kwargs)
    assert exc.value.status_code == 409

    # Enrolled for inference, not linked.
    await local_authority["admit"]("tdv_mac_1", "macos", version=2)

    async def _offline(_owner, _device):
        return False

    monkeypatch.setattr(pod_turn, "_puppy_link_available", _offline)
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=payload, stream_fn=_run, **kwargs)
    assert exc.value.status_code == 409 and exc.value.detail["reason"] == "device not linked"

    # Enrolled and linked: the turn runs on the session, with no hub grant anywhere.
    async def _linked(_owner, _device):
        return True

    monkeypatch.setattr(pod_turn, "_puppy_link_available", _linked)
    result = await pod_turn.run_pod_turn(payload=payload, stream_fn=_run, **kwargs)
    assert result["runtimeMode"] == "puppy_relay" and result["provider"] == "puppy"
    assert seen["runtime_credential"].startswith("pod-session:")
    assert seen["puppy_device_id"] == "tdv_mac_1"

    # Revoked at the pod: the very next turn is refused before the runner.
    await authority.revoke_subject("tdv_mac_1")
    seen.clear()
    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(payload=payload, stream_fn=_run, **kwargs)
    assert exc.value.status_code == 409
    assert not seen


async def test_hub_path_tests_are_unchanged_by_the_local_door(enabled, monkeypatch):
    """The hub-relayed turn still works exactly as before: no session, hub verdict."""
    _consent_ok(monkeypatch)
    events = [_Event("token", "hub answer")]
    result = await pod_turn.run_pod_turn(
        payload=_payload(), consent_token="t", stream_fn=_stream(events)
    )
    assert result["text"] == "hub answer"


async def test_a_local_token_without_its_session_is_refused_before_the_turn_runs(
    enabled, monkeypatch, local_authority
):
    """Omitting the claims must not buy the owner-local door with no role check.

    ``run_pod_turn`` only asked the role question when a ``session`` was passed, so
    a caller that supplied the local token and the local verifier but no claims
    reached the turn with nothing asked at all. The guard keys on the TOKEN's shape
    (``pod-session:``), which only the pod's own authority mints, so it cannot be
    dodged by leaving an argument out.
    """
    from hushh_mcp.services import pod_consent_client

    async def _never(*_a, **_k):
        raise AssertionError("the hub was asked on an owner-local turn")

    monkeypatch.setattr(pod_consent_client, "verify_consent", _never)
    authority = local_authority["authority"]
    _, claims = await local_authority["admit"]("tdv_app_1", "web")
    ran: dict = {}

    async def _run(**kwargs):
        ran.update(kwargs)
        yield _Event("token", "should never answer")

    with pytest.raises(HTTPException) as exc:
        await pod_turn.run_pod_turn(
            payload=_payload(),
            consent_token=authority.local_token(claims),
            verifier=authority.local_verifier(claims),
            session=None,
            stream_fn=_run,
        )
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "session_required"
    assert not ran, "the turn must be refused before the runner is reached"

    # The partner control: the same token WITH its claims runs, so what the guard
    # refuses is the missing session and not the local door itself.
    result = await pod_turn.run_pod_turn(
        payload=_payload(),
        stream_fn=_stream([_Event("token", "local answer")]),
        **_local_turn_kwargs(authority, claims),
    )
    assert result["text"] == "local answer"


async def test_the_turn_and_the_memory_doors_refuse_a_sessionless_local_token_alike(
    local_authority,
):
    """``pod_memory``'s module docstring says the two doors behave the same way.

    It said so while only the memory side refused this. Pinned here rather than
    left as prose, so the next divergence is a red test and not a stale claim.
    """
    from api.routes.one import pod_memory

    authority = local_authority["authority"]
    _, claims = await local_authority["admit"]("tdv_app_1", "web")
    token = authority.local_token(claims)

    with pytest.raises(HTTPException) as turn_side:
        pod_turn._require_local_session(token, None)
    with pytest.raises(HTTPException) as memory_side:
        pod_memory._require_local_session(token, None)
    assert turn_side.value.status_code == memory_side.value.status_code == 403
    assert turn_side.value.detail == memory_side.value.detail

    # And a device-role session is the same refusal on both, by the same code.
    _, device = await local_authority["admit"]("tdv_mac_1", "macos")
    with pytest.raises(HTTPException) as turn_role:
        pod_turn._require_local_session(authority.local_token(device), device)
    with pytest.raises(HTTPException) as memory_role:
        pod_memory._require_local_session(authority.local_token(device), device)
    assert (
        turn_role.value.detail
        == memory_role.value.detail
        == {
            "code": "role_mismatch",
            "message": "an app-role session is required",
        }
    )


# --- The fence the memory gate consults ------------------------------------------
#
# `_memory_commit_allowed` is what the turn hands the runtime so a fenced
# incarnation finishes its answer and publishes nothing. It was untested on both
# sides: a grep of the whole test tree for its name returned nothing. It is a
# fail-closed control over a shared durable log, so "untested" is the wrong
# state for it to be in.


class _Lease:
    def __init__(self, answer):
        self._answer = answer
        self.asked = 0

    async def is_current(self):
        self.asked += 1
        return self._answer


class _Authority:
    def __init__(self, lease):
        self.lease = lease


@pytest.mark.asyncio
async def test_no_authority_means_allowed(monkeypatch):
    """The hub and the tests hold no incarnation, so there is no fence to fail."""
    from hushh_mcp.services import pod_session_authority

    monkeypatch.setattr(pod_session_authority, "active_session_authority", lambda: None)

    assert await pod_turn._memory_commit_allowed() is True


@pytest.mark.asyncio
async def test_a_held_fence_allows_the_commit(monkeypatch):
    from hushh_mcp.services import pod_session_authority

    lease = _Lease(True)
    monkeypatch.setattr(
        pod_session_authority, "active_session_authority", lambda: _Authority(lease)
    )

    assert await pod_turn._memory_commit_allowed() is True
    assert lease.asked == 1, "the fence has to be consulted, not assumed"


@pytest.mark.asyncio
async def test_a_lost_fence_refuses_the_commit(monkeypatch):
    from hushh_mcp.services import pod_session_authority

    monkeypatch.setattr(
        pod_session_authority, "active_session_authority", lambda: _Authority(_Lease(False))
    )

    assert await pod_turn._memory_commit_allowed() is False


@pytest.mark.asyncio
async def test_an_uncertain_fence_refuses_the_commit(monkeypatch):
    """`is_current` has three answers and only one of them may write.

    Uncertain means the CAS read did not resolve. Two incarnations writing the
    same log is precisely what the fence exists to stop, so uncertainty fails
    closed. The comparison is `is True` and not truthiness for this reason.
    """
    from hushh_mcp.services import pod_session_authority

    for uncertain in (None, "yes", 1):
        monkeypatch.setattr(
            pod_session_authority,
            "active_session_authority",
            lambda lease=_Lease(uncertain): _Authority(lease),
        )
        assert await pod_turn._memory_commit_allowed() is False, uncertain
