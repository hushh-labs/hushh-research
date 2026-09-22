"""Replay fixture-only real Gemini Nav/Consent recordings with no network."""

from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import yaml
from google.adk.agents.callback_context import CallbackContext
from google.adk.cli.plugins.recordings_plugin import RecordingsPlugin
from google.adk.cli.plugins.replay_plugin import ReplayPlugin, ReplayVerificationError
from google.adk.models.base_llm import BaseLlm
from google.adk.tools.agent_tool import AgentTool

from scripts import conformance_specialist as harness

RECORDINGS = Path(__file__).parent / "conformance" / "nav"
MODEL = "gemini-3.8-flash"
CASES = (
    harness.CaseSpec(
        id="active",
        user_message="Who can see my location right now?",
        state={"hussh:timezone": "UTC"},
    ),
    harness.CaseSpec(
        id="history",
        user_message="Show my previously revoked location sharing.",
        state={"hussh:timezone": "UTC"},
    ),
)


class NestedRecordingsPlugin(RecordingsPlugin):
    """ADK 2.9 child runners overwrite a shared file; retain each agent's exchanges."""

    async def before_run_callback(self, *, invocation_context):
        ctx = CallbackContext(invocation_context)
        config = ctx.state.get(harness.RECORD_STATE_KEY)
        if config:
            self._fixture_record_config = dict(config)
        else:
            invocation_context.session.state[harness.RECORD_STATE_KEY] = dict(
                self._fixture_record_config
            )
        return await super().before_run_callback(invocation_context=invocation_context)

    async def after_run_callback(self, *, invocation_context):
        state = self._get_invocation_state(CallbackContext(invocation_context))
        if state is None:
            return await super().after_run_callback(invocation_context=invocation_context)
        path = Path(state.test_case_path) / "generated-recordings.yaml"
        previous = yaml.safe_load(path.read_text())["recordings"] if path.exists() else []
        await super().after_run_callback(invocation_context=invocation_context)
        payload = yaml.safe_load(path.read_text())
        present = {row["agent_name"] for row in payload["recordings"]}
        payload["recordings"].extend(row for row in previous if row["agent_name"] not in present)
        path.write_text(yaml.safe_dump(payload, sort_keys=False))


class NestedReplayPlugin(ReplayPlugin):
    """Replay real AgentTools so child calls and state/actions are verified too.

    Stock 2.9 explicitly skips AgentTool execution, dropping skip_summarization
    and state propagation. Keep this compatibility seam test-local.
    """

    async def before_run_callback(self, *, invocation_context):
        ctx = CallbackContext(invocation_context)
        config = ctx.state.get(harness.REPLAY_STATE_KEY)
        if config:
            self._fixture_replay_config = dict(config)
        else:
            invocation_context.session.state[harness.REPLAY_STATE_KEY] = dict(
                self._fixture_replay_config
            )
        return await super().before_run_callback(invocation_context=invocation_context)

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        if not isinstance(tool, AgentTool):
            return await super().before_tool_callback(
                tool=tool, tool_args=tool_args, tool_context=tool_context
            )
        state = self._get_invocation_state(tool_context)
        assert state is not None
        recording = self._verify_and_get_next_tool_recording_for_agent(
            state, tool_context.agent_name, tool.name, tool_args
        )
        result = await tool.run_async(args=tool_args, tool_context=tool_context)
        expected = recording.tool_response.response
        normalized = result if isinstance(result, dict) else {"result": result}
        if normalized != expected:
            raise ReplayVerificationError("Nested AgentTool response differs from recording")
        return result


class NoNetworkModel(BaseLlm):
    async def generate_content_async(self, *args, **kwargs):
        raise AssertionError("Conformance replay must not call a model")
        yield  # pragma: no cover - satisfy the async generator interface


@contextmanager
def fixture_boundary():
    from hushh_mcp.hushh_adk import tools
    from hushh_mcp.hushh_adk.context import HushhContext
    from hushh_mcp.services.consent_center_service import ConsentCenterService

    async def admitted(token, *, expected_scope):
        assert token == "fixture-only-not-a-token"
        assert str(getattr(expected_scope, "value", expected_scope)) == "agent.nav.review"
        return True, None, SimpleNamespace(user_id=harness.FIXTURE_USER_ID)

    async def list_center(self, user_id, **kwargs):
        assert user_id == harness.FIXTURE_USER_ID
        assert kwargs == {"actor": "investor", "surface": kwargs["surface"], "top": 10}
        assert kwargs["surface"] in {"active", "previous"}
        return {
            "total": 1,
            "items": [
                {
                    "id": "one_location_grant:fixture-grant",
                    "counterpart_label": "Fixture Alex",
                    "scope": "cap.location.live.view",
                    "status": "active" if kwargs["surface"] == "active" else "revoked",
                    "metadata": {"grant_id": "fixture-grant"},
                }
            ],
        }

    with (
        patch.object(tools, "validate_token_with_db", admitted),
        patch.object(ConsentCenterService, "list_center", list_center),
        HushhContext(user_id=harness.FIXTURE_USER_ID, consent_token="fixture-only-not-a-token"),  # noqa: S106 - synthetic fixture
    ):
        yield


def fixture_agent(model=None):
    from hushh_mcp.agents.nav.agent import build_nav_agent

    return build_nav_agent(model=model or NoNetworkModel(model=MODEL))


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.id)
def test_real_nav_recording_replays_offline(case):
    with (
        fixture_boundary(),
        patch.object(harness, "ReplayPlugin", NestedReplayPlugin),
        patch("socket.socket.connect", side_effect=AssertionError("Network forbidden in replay")),
    ):
        result = harness.replay_case(fixture_agent, RECORDINGS / case.id)
    assert result.passed, f"{result.error_type}: {result.error}"
    assert result.session_compared
    assert result.event_count > 0


async def test_nested_adapter_records_and_rejects_child_argument_drift(tmp_path):
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    from tests.test_conformance_harness import ScriptedLlm

    def response(call=None, text=None):
        return LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(function_call=call) if call else types.Part(text=text)],
            )
        )

    scripted = ScriptedLlm(
        model=MODEL,
        responses=[
            response(types.FunctionCall(name="consent", args={"request": CASES[0].user_message})),
            response(types.FunctionCall(name="list_active_consent_grants", args={})),
            response(
                text="Fixture Alex can view your live location. Use the card to manage sharing."
            ),
        ],
    )
    with fixture_boundary(), patch.object(harness, "RecordingsPlugin", NestedRecordingsPlugin):
        layout = await harness.record_case(lambda: fixture_agent(scripted), CASES[0], tmp_path)
    assert scripted.calls == 3
    payload = yaml.safe_load(layout.recordings_file.read_text())
    assert {row["agent_name"] for row in payload["recordings"]} == {"nav", "consent"}
    with (
        fixture_boundary(),
        patch.object(harness, "ReplayPlugin", NestedReplayPlugin),
        patch("socket.socket.connect", side_effect=AssertionError("Network forbidden")),
    ):
        result = await harness.replay_case_async(fixture_agent, layout.case_dir)
        assert result.passed, result.error
        original = deepcopy(payload)
        for row in payload["recordings"]:
            if row["agent_name"] == "consent" and row.get("tool_recording"):
                row["tool_recording"]["tool_call"]["args"] = {"unexpected": "fixture"}
        layout.recordings_file.write_text(yaml.safe_dump(payload))
        result = await harness.replay_case_async(fixture_agent, layout.case_dir)
        assert not result.passed
        assert result.error_type == "ReplayVerificationError"
        for row in original["recordings"]:
            if row["agent_name"] == "consent" and row.get("tool_recording"):
                row["tool_recording"]["tool_response"]["response"] = {"items": [], "total": 0}
        layout.recordings_file.write_text(yaml.safe_dump(original))
        result = await harness.replay_case_async(fixture_agent, layout.case_dir)
        assert not result.passed
        assert result.error_type == "ReplayVerificationError"
