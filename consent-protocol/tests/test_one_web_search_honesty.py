"""One on a non-Gemini head: no Google Search tool, and one honest sentence instead.

ADK refuses its Google Search tool for any model that is not Gemini, so an Azure OpenAI
head (``user_azure_mi``) or a Puppy head that held it failed as a tool error the moment
someone asked for something fresh. Such a head is now built without the tool and told
to say plainly that web search is not available on this setup yet. A Gemini head is
the negative control: unchanged. The pod's capability report says the same thing, from
the same predicate (``hushh_mcp/one_adk/web_search.py``).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from types import SimpleNamespace

import pytest
from google.adk.models import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.google_search_tool import GoogleSearchTool
from google.genai import types as genai_types

from api.routes.one.pod_capabilities import pod_capabilities, web_search_capability
from hushh_mcp.one_adk import agent_tree, web_search
from hushh_mcp.one_adk.text_runtime import _runtime_model
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel

_SENTENCE = "Web search is not available on this setup yet."
_AZURE_TOPOLOGY = ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT")


def _azure_head():
    """The exact head a ``user_azure_mi`` turn builds."""
    return _runtime_model(
        runtime_model="gpt-5-mini",
        runtime_mode="user_azure_mi",
        runtime_credential=None,
        runtime_provider="azure_openai",
    )


def _puppy_head():
    """The exact head a ``puppy_relay`` turn builds."""
    return _runtime_model(
        runtime_model="qwen3-local",
        runtime_mode="puppy_relay",
        runtime_credential="synthetic-inference-grant",
        runtime_provider="puppy",
        puppy_device_id="device-1",
    )


def _gemini_head():
    return Gemini(model="gemini-turn-local", client_kwargs={"api_key": "turn-local-test-key"})


def _names(agent) -> set[str]:
    return {getattr(t, "name", getattr(t, "__name__", type(t).__name__)) for t in agent.tools}


def _search_tools(agent) -> list:
    """Every Google Search tool reachable from ``agent``, through nested agent tools."""
    found: list = []
    for tool in agent.tools:
        if isinstance(tool, GoogleSearchTool):
            found.append(tool)
        if isinstance(tool, AgentTool):
            found.extend(_search_tools(tool.agent))
    return found


def _instruction(agent) -> str:
    return agent.instruction(SimpleNamespace(state={}))


# -- the head -----------------------------------------------------------------------


async def test_adk_refuses_google_search_for_the_azure_deployment(monkeypatch):
    """The premise: on a non-Gemini head the tool is an error, never a quiet no-op."""
    monkeypatch.delenv("ADK_DISABLE_GEMINI_MODEL_ID_CHECK", raising=False)
    request = LlmRequest(model=_azure_head().model)
    with pytest.raises(ValueError, match="Google search tool is not supported"):
        await GoogleSearchTool().process_llm_request(tool_context=None, llm_request=request)


@pytest.mark.parametrize("head", [_azure_head, _puppy_head], ids=["azure_openai", "puppy"])
def test_a_non_gemini_head_has_no_google_search_and_says_so(head):
    model = head()
    agent = agent_tree.build_one_text_agent(model=model)
    assert agent.model is model
    assert "google_search" not in _names(agent)
    assert _search_tools(agent) == []
    instruction = _instruction(agent)
    assert instruction.endswith(web_search.WEB_SEARCH_UNAVAILABLE_INSTRUCTION)
    assert instruction.count(_SENTENCE) == 1


def test_a_gemini_head_keeps_google_search_unchanged():
    model = _gemini_head()
    agent = agent_tree.build_one_text_agent(model=model)
    search = next(t for t in agent.tools if getattr(t, "name", "") == "google_search")
    assert isinstance(search, AgentTool) and search.propagate_grounding_metadata is True
    assert search.agent.model is model
    assert [type(t) for t in search.agent.tools] == [GoogleSearchTool]
    assert agent.instruction is agent_tree._one_runtime_instruction
    assert _SENTENCE not in _instruction(agent)


def test_only_the_search_tool_differs_between_the_heads():
    gemini = _names(agent_tree.build_one_text_agent(model=_gemini_head()))
    azure = _names(agent_tree.build_one_text_agent(model=_azure_head()))
    assert gemini - azure == {"google_search"}
    assert azure - gemini == set()


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        ("gemini", True),
        ("google", True),
        ("azure_openai", False),
        ("puppy", False),
        ("openai", False),
        ("", False),
        (None, False),
    ],
)
def test_only_a_gemini_provider_has_web_search(provider, expected):
    assert web_search.provider_supports_web_search(provider) is expected


def test_the_head_is_judged_by_its_declared_provider_not_its_adapter():
    through_adapter = ProviderAdkModel(model="gemini-turn-local", provider="gemini", credential="k")
    assert web_search.head_supports_web_search(through_adapter) is True
    assert web_search.head_supports_web_search(_gemini_head()) is True
    assert web_search.head_supports_web_search("gemini-3.6-flash") is True
    assert web_search.head_supports_web_search(_azure_head()) is False
    assert web_search.head_supports_web_search(_puppy_head()) is False


# -- the turn, at the model request boundary ------------------------------------------


class _CapturingHead(ProviderAdkModel):
    """A head that records the request ADK would send and answers without a provider."""

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        del stream
        _CAPTURED.append(llm_request)
        yield LlmResponse(
            content=genai_types.Content(role="model", parts=[genai_types.Part(text="ok")]),
            partial=False,
            turn_complete=True,
        )


_CAPTURED: list[LlmRequest] = []


async def _request_for(provider: str) -> LlmRequest:
    _CAPTURED.clear()
    head = _CapturingHead(model="head-under-test", provider=provider, credential="")
    runner = Runner(
        app_name=agent_tree.ONE_APP_NAME,
        agent=agent_tree.build_one_text_agent(model=head),
        session_service=InMemorySessionService(),
        auto_create_session=True,
    )
    message = genai_types.Content(role="user", parts=[genai_types.Part(text="news today?")])
    async for _event in runner.run_async(user_id="u1", session_id="s1", new_message=message):
        pass
    assert len(_CAPTURED) == 1
    return _CAPTURED[0]


def _declared(request: LlmRequest) -> set[str]:
    tools = request.config.tools or []
    return {fn.name for tool in tools for fn in (tool.function_declarations or [])}


def _system_text(request: LlmRequest) -> str:
    return str(request.config.system_instruction or "")


@pytest.mark.parametrize("provider", ["azure_openai", "puppy"])
async def test_a_non_gemini_turn_sends_no_search_and_the_honest_sentence(provider):
    request = await _request_for(provider)
    assert "google_search" not in _declared(request)
    assert all(getattr(tool, "google_search", None) is None for tool in request.config.tools)
    assert _SENTENCE in _system_text(request)


async def test_a_gemini_turn_still_declares_search_and_no_sentence():
    request = await _request_for("gemini")
    assert "google_search" in _declared(request)
    assert _SENTENCE not in _system_text(request)


# -- the capability report (``/pod/info``, relayed to the hub) ------------------------


def _own_model(monkeypatch, **topology: str) -> None:
    for name in _AZURE_TOPOLOGY:
        monkeypatch.delenv(name, raising=False)
    for name, value in topology.items():
        monkeypatch.setenv(name, value)


def test_a_pod_on_its_own_azure_model_reports_no_web_search(monkeypatch):
    _own_model(
        monkeypatch,
        AZURE_OPENAI_ENDPOINT="https://owner-ai.openai.azure.com/",
        AZURE_OPENAI_DEPLOYMENT="gpt-5-mini",
    )
    assert web_search_capability() == {"available": False, "reason": "requires_gemini_model"}


def test_a_half_rendered_azure_model_reports_without_raising(monkeypatch):
    _own_model(monkeypatch, AZURE_OPENAI_DEPLOYMENT="gpt-5-mini")
    assert web_search_capability() == {"available": False, "reason": "requires_gemini_model"}


def test_a_google_cloud_pod_keeps_web_search(monkeypatch):
    _own_model(monkeypatch)
    monkeypatch.delenv("CONTAINER_APP_NAME", raising=False)
    monkeypatch.setenv("K_SERVICE", "one-pod-ha1")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "owner-project")
    assert pod_capabilities()["webSearch"] == {"available": True, "reason": None}


def test_pod_info_carries_web_search_for_the_hub(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    pod_server = pytest.importorskip("pod_server")
    for name in ("GOOGLE_CLOUD_PROJECT", "GENAI_GOOGLE_CLOUD_PROJECT", "K_SERVICE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CONTAINER_APP_NAME", "one-pod-ha1")
    monkeypatch.setenv("HUSSH_ID", "ha1_owner")
    _own_model(
        monkeypatch,
        AZURE_OPENAI_ENDPOINT="https://owner-ai.openai.azure.com/",
        AZURE_OPENAI_DEPLOYMENT="gpt-5-mini",
    )
    capabilities = pod_server.pod_info()["capabilities"]
    assert capabilities["webSearch"] == {"available": False, "reason": "requires_gemini_model"}
