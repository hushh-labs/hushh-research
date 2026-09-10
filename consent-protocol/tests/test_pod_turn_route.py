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
