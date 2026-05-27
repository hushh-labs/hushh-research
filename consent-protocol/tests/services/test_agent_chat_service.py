from __future__ import annotations

from types import SimpleNamespace

import pytest
from google.genai import errors as genai_errors

from hushh_mcp.services.agent_chat_service import (
    AGENT_RUNTIME_CREDENTIAL_REF,
    AGENT_SYSTEM_PROMPT,
    DEFAULT_AGENT_CHAT_MODEL,
    AgentChatMessage,
    AgentChatService,
    AgentRuntimeProviderError,
    RuntimeSecretSession,
    create_runtime_client,
)
from hussh_sdk import RuntimeCredentialMissingError


class _FakeAioModels:
    def __init__(
        self, *, planner_error: Exception | None = None, stream_error: Exception | None = None
    ):
        self.planner_error = planner_error
        self.stream_error = stream_error

    async def generate_content(self, **_kwargs):
        if self.planner_error is not None:
            raise self.planner_error
        return SimpleNamespace(function_calls=[])

    async def generate_content_stream(self, **_kwargs):
        if self.stream_error is not None:
            raise self.stream_error

        async def _empty_stream():
            if False:
                yield None

        return _empty_stream()


class _FakeRuntimeClient:
    def __init__(
        self, *, planner_error: Exception | None = None, stream_error: Exception | None = None
    ):
        self.aio = SimpleNamespace(
            models=_FakeAioModels(planner_error=planner_error, stream_error=stream_error)
        )


def test_agent_chat_service_defaults_to_stable_gemini_model(monkeypatch, test_vault_key):
    monkeypatch.setenv("AGENT_GEMINI_MODEL", "gemini-2.5-pro")

    service = AgentChatService(vault_key_hex=test_vault_key)

    assert service.model == DEFAULT_AGENT_CHAT_MODEL == "gemini-2.5-flash"


class FakeGeminiClient:
    def __init__(self, *, api_key: str, vertexai: bool):
        self.api_key = api_key
        self.vertexai = vertexai


def test_agent_chat_create_runtime_client_uses_user_key_not_env(monkeypatch):
    created_clients: list[FakeGeminiClient] = []

    def fake_client(*, vertexai: bool, api_key: str):
        client = FakeGeminiClient(vertexai=vertexai, api_key=api_key)
        created_clients.append(client)
        return client

    monkeypatch.setenv("GOOGLE_API_KEY", "env-google-key")
    monkeypatch.setenv("GEMINI_API_KEY", "env-gemini-key")
    monkeypatch.setattr("hushh_mcp.services.agent_chat_service.genai.Client", fake_client)

    client = create_runtime_client("gemini", " USER_GEMINI_KEY ")

    assert isinstance(client, FakeGeminiClient)
    assert client.api_key == "USER_GEMINI_KEY"
    assert client.vertexai is False
    assert created_clients == [client]


async def test_agent_chat_create_byok_client_logs_redacted_evidence(
    caplog, monkeypatch, test_vault_key
):
    def fake_client(*, vertexai: bool, api_key: str):
        return FakeGeminiClient(vertexai=vertexai, api_key=api_key)

    monkeypatch.setattr("hushh_mcp.services.agent_chat_service.genai.Client", fake_client)
    service = AgentChatService(vault_key_hex=test_vault_key)

    with caplog.at_level("INFO", logger="hushh_mcp.services.agent_chat_service"):
        client, runtime = await service.create_byok_client("USER_GEMINI_KEY")

    assert isinstance(client, FakeGeminiClient)
    assert client.api_key == "USER_GEMINI_KEY"
    assert runtime.model.provider == "gemini"
    assert runtime.model.model == "gemini-2.5-flash"
    assert runtime.model.mode == "byok"
    assert runtime.model.credential_ref == AGENT_RUNTIME_CREDENTIAL_REF
    assert "agent_chat_runtime_evidence=" in caplog.text
    assert "USER_GEMINI_KEY" not in caplog.text


async def test_agent_chat_managed_vertex_mode_does_not_require_user_key(
    caplog, monkeypatch, test_vault_key
):
    created: list[dict[str, object]] = []

    def fake_client(**kwargs):
        created.append(kwargs)
        return SimpleNamespace(kind="managed_vertex")

    monkeypatch.setenv("GOOGLE_API_KEY", "hushh-managed-key")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test-project")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    monkeypatch.setattr("hushh_mcp.services.agent_chat_service.genai.Client", fake_client)
    service = AgentChatService(vault_key_hex=test_vault_key)

    with caplog.at_level("INFO", logger="hushh_mcp.services.agent_chat_service"):
        client, runtime = await service.create_agent_runtime_client(
            None,
            "hushh_managed_vertex",
        )

    assert client.kind == "managed_vertex"
    assert runtime.model.mode == "hushh_managed_vertex"
    assert created == [
        {
            "api_key": "hushh-managed-key",
        }
    ]
    assert "resolution_source': 'hushh_managed_vertex'" in caplog.text


async def test_agent_chat_managed_vertex_missing_backend_key_fails_before_provider_call(
    caplog, monkeypatch, test_vault_key
):
    created: list[dict[str, object]] = []

    def fake_client(**kwargs):
        created.append(kwargs)
        return SimpleNamespace(kind="managed_vertex")

    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setattr(
        "hushh_mcp.services.agent_chat_service.genai.Client",
        fake_client,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.agent_chat_service.get_core_security_settings",
        lambda: SimpleNamespace(google_api_key=""),
    )
    service = AgentChatService(vault_key_hex=test_vault_key)

    with caplog.at_level("WARNING", logger="hushh_mcp.services.agent_chat_service"):
        with pytest.raises(AgentRuntimeProviderError) as exc_info:
            await service.create_agent_runtime_client(None, "hushh_managed_vertex")

    assert created == []
    assert exc_info.value.error_code == "AGENT_RUNTIME_MANAGED_VERTEX_UNAVAILABLE"
    assert exc_info.value.detail["likely_issue"] == "managed_vertex_unavailable"
    assert "phase=client_init" in caplog.text


async def test_agent_chat_missing_byok_key_fails_clearly(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    with pytest.raises(RuntimeCredentialMissingError, match=AGENT_RUNTIME_CREDENTIAL_REF):
        await service.create_byok_client(None)


async def test_agent_chat_credential_ref_mismatch_fails(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)
    fixture_value = "USER_GEMINI_KEY"
    session = RuntimeSecretSession(
        credential_ref="pkm:runtime_secrets.llm.other_key",
        secret=fixture_value,
    )

    with pytest.raises(RuntimeCredentialMissingError, match=AGENT_RUNTIME_CREDENTIAL_REF):
        await service.create_byok_client(await session.read_secret(AGENT_RUNTIME_CREDENTIAL_REF))


async def test_agent_chat_logs_bad_byok_key_provider_error_for_planner(caplog, test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)
    raw_key = "BAD_USER_GEMINI_KEY"
    client = _FakeRuntimeClient(
        planner_error=genai_errors.ClientError(
            400,
            {
                "error": {
                    "code": 400,
                    "status": "INVALID_ARGUMENT",
                    "message": "API key not valid. Please pass a valid API key.",
                    "details": [
                        {
                            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                            "reason": "API_KEY_INVALID",
                            "domain": "googleapis.com",
                            "metadata": {
                                "service": "generativelanguage.googleapis.com",
                            },
                        }
                    ],
                }
            },
        )
    )

    with caplog.at_level("WARNING", logger="hushh_mcp.services.agent_chat_service"):
        with pytest.raises(AgentRuntimeProviderError) as exc_info:
            await service.plan_action_with_gemini(
                user_message="tell me a joke",
                history=[],
                runtime_client=client,
                runtime_model=DEFAULT_AGENT_CHAT_MODEL,
            )

    assert exc_info.value.error_code == "AGENT_RUNTIME_API_KEY_INVALID"
    assert "Gemini key" in exc_info.value.message
    assert "agent_chat_runtime_provider_error phase=planner" in caplog.text
    assert "credential_ref=pkm:runtime_secrets.llm.gemini_api_key" in caplog.text
    assert "'likely_issue': 'invalid_or_unauthorized_api_key'" in caplog.text
    assert "'provider_reason': 'API_KEY_INVALID'" in caplog.text
    assert "'provider_service': 'generativelanguage.googleapis.com'" in caplog.text
    assert "BAD_USER_GEMINI_KEY" not in caplog.text
    assert raw_key not in caplog.text


async def test_agent_chat_logs_bad_byok_key_provider_error_for_stream(caplog, test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)
    raw_key = "BAD_USER_GEMINI_KEY"
    client = _FakeRuntimeClient(
        stream_error=genai_errors.ClientError(
            403,
            {
                "error": {
                    "code": 403,
                    "status": "PERMISSION_DENIED",
                    "message": "API key not valid. Please pass a valid API key.",
                    "details": [
                        {
                            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                            "reason": "API_KEY_INVALID",
                            "domain": "googleapis.com",
                            "metadata": {
                                "service": "generativelanguage.googleapis.com",
                            },
                        }
                    ],
                }
            },
        )
    )

    with caplog.at_level("WARNING", logger="hushh_mcp.services.agent_chat_service"):
        with pytest.raises(AgentRuntimeProviderError) as exc_info:
            async for _token in service.stream_response(
                user_message="tell me a joke",
                history=[],
                runtime_client=client,
                runtime_model=DEFAULT_AGENT_CHAT_MODEL,
            ):
                pass

    assert exc_info.value.error_code == "AGENT_RUNTIME_API_KEY_INVALID"
    assert "Gemini key" in exc_info.value.message
    assert "agent_chat_runtime_provider_error phase=stream" in caplog.text
    assert "credential_ref=pkm:runtime_secrets.llm.gemini_api_key" in caplog.text
    assert "'likely_issue': 'invalid_or_unauthorized_api_key'" in caplog.text
    assert "'provider_reason': 'API_KEY_INVALID'" in caplog.text
    assert "'provider_service': 'generativelanguage.googleapis.com'" in caplog.text
    assert "BAD_USER_GEMINI_KEY" not in caplog.text
    assert raw_key not in caplog.text


async def test_agent_chat_logs_wrong_google_api_surface_provider_error(caplog, test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)
    client = _FakeRuntimeClient(
        planner_error=genai_errors.ClientError(
            401,
            {
                "error": {
                    "code": 401,
                    "status": "UNAUTHENTICATED",
                    "message": "API keys are not supported by this API.",
                    "details": [
                        {
                            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                            "reason": "CREDENTIALS_MISSING",
                            "domain": "googleapis.com",
                            "metadata": {
                                "method": "google.cloud.aiplatform.v1beta1.PredictionService.GenerateContent",
                                "service": "aiplatform.googleapis.com",
                            },
                        }
                    ],
                }
            },
        )
    )

    with caplog.at_level("WARNING", logger="hushh_mcp.services.agent_chat_service"):
        with pytest.raises(AgentRuntimeProviderError) as exc_info:
            await service.plan_action_with_gemini(
                user_message="tell me a joke",
                history=[],
                runtime_client=client,
                runtime_model=DEFAULT_AGENT_CHAT_MODEL,
            )

    assert exc_info.value.error_code == "AGENT_RUNTIME_GOOGLE_API_SURFACE_INVALID"
    assert "'likely_issue': 'wrong_google_api_surface'" in caplog.text
    assert "'provider_reason': 'CREDENTIALS_MISSING'" in caplog.text
    assert "'provider_service': 'aiplatform.googleapis.com'" in caplog.text


def test_agent_chat_service_uses_manifest_model_not_env(monkeypatch, test_vault_key):
    monkeypatch.setenv("AGENT_GEMINI_MODEL", "gemini-2.5-flash")

    service = AgentChatService(vault_key_hex=test_vault_key)

    assert service.model == "gemini-2.5-flash"


def test_agent_chat_service_decrypts_encrypted_conversation_and_message(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)
    title = service._encrypt_text("Plan the product launch")
    content = service._encrypt_text("Hello from encrypted history")

    conversation = service._conversation_from_row(
        {
            "id": "conversation-1",
            "user_id": "user-1",
            "title_ciphertext": title.ciphertext,
            "title_iv": title.iv,
            "title_tag": title.tag,
            "model": "gemini-2.5-pro",
            "message_count": 2,
        }
    )
    message = service._message_from_row(
        {
            "id": "message-1",
            "conversation_id": "conversation-1",
            "user_id": "user-1",
            "role": "assistant",
            "status": "complete",
            "content_ciphertext": content.ciphertext,
            "content_iv": content.iv,
            "content_tag": content.tag,
            "model": "gemini-2.5-pro",
        }
    )

    assert conversation.title == "Plan the product launch"
    assert conversation.message_count == 2
    assert message.content == "Hello from encrypted history"
    assert message.role == "assistant"


def test_agent_chat_contents_use_system_instruction_boundary_and_planned_action(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)
    action_plan = service.plan_action("Start analysis of Nvidia")
    assert action_plan is not None
    assert action_plan.action_id == "analysis.start"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {"symbol": "NVDA"}

    contents = service._build_contents(
        user_message="Start analysis of Nvidia",
        history=[
            AgentChatMessage(
                id="message-1",
                conversation_id="conversation-1",
                user_id="user-1",
                role="user",
                status="complete",
                content="Can you help with stocks?",
                model=None,
                created_at=None,
                completed_at=None,
            ),
            AgentChatMessage(
                id="message-2",
                conversation_id="conversation-1",
                user_id="user-1",
                role="assistant",
                status="complete",
                content="Yes, I can help with Kai market workflows.",
                model="gemini-2.5-pro",
                created_at=None,
                completed_at=None,
            ),
        ],
        action_plan=action_plan,
        pkm_context="Saved domains: Financial\n- Financial: prefers long-term portfolio reviews.",
    )
    current_turn_text = contents[-1].parts[0].text or ""

    assert "Kai-focused financial assistant" in AGENT_SYSTEM_PROMPT
    assert contents[0].role == "user"
    assert contents[0].parts[0].text == "Can you help with stocks?"
    assert contents[1].role == "model"
    assert contents[1].parts[0].text == "Yes, I can help with Kai market workflows."
    assert "Action context:" in current_turn_text
    assert "PKM context:" in current_turn_text
    assert "prefers long-term portfolio reviews" in current_turn_text
    assert "action_id: analysis.start" in current_turn_text
    assert "slots: {'symbol': 'NVDA'}" in current_turn_text
    assert "Latest user message:\nStart analysis of Nvidia" in current_turn_text
    assert AGENT_SYSTEM_PROMPT not in current_turn_text


def test_agent_chat_translates_gemini_function_call_to_frontend_analysis(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service._action_plan_from_function_call(
        SimpleNamespace(
            id="gemini-call-1",
            name="start_stock_analysis",
            args={"company": "Nvidia"},
        )
    )

    assert action_plan is not None
    assert action_plan.call_id == "gemini-call-1"
    assert action_plan.action_id == "analysis.start"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {"symbol": "NVDA"}


def test_agent_chat_translates_gemini_function_call_to_frontend_navigation(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service._action_plan_from_function_call(
        SimpleNamespace(
            id="gemini-call-2",
            name="open_app_surface",
            args={"surface": "consent_center"},
        )
    )

    assert action_plan is not None
    assert action_plan.call_id == "gemini-call-2"
    assert action_plan.action_id == "route.consents"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_translates_gemini_function_call_to_pkm_add(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service._action_plan_from_function_call(
        SimpleNamespace(
            id="gemini-call-3",
            name="add_to_pkm",
            args={
                "memory_text": "My name is Akshat Kumar and I study at IIT Bombay.",
                "reason": "durable personal context",
            },
        )
    )

    assert action_plan is not None
    assert action_plan.call_id == "gemini-call-3"
    assert action_plan.action_id == "pkm.add"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}
    assert action_plan.message == "Checking PKM and saving what fits."
    assert action_plan.reason == "durable personal context"


def test_agent_chat_plans_safe_navigation_actions(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Can you open the consent center?")

    assert action_plan is not None
    assert action_plan.action_id == "route.consents"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_plans_explicit_pkm_add(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service.plan_action(
        "Can you add this information in my PKM: my name is Akshat Kumar."
    )

    assert action_plan is not None
    assert action_plan.action_id == "pkm.add"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_plans_pkm_navigation(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Please open my PKM memory lab")

    assert action_plan is not None
    assert action_plan.action_id == "route.profile_pkm_agent_lab"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_prefers_import_over_dashboard_for_portfolio_import(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Please open portfolio import")

    assert action_plan is not None
    assert action_plan.action_id == "route.kai_import"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_blocks_destructive_actions(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Delete my account and all vault data")

    assert action_plan is not None
    assert action_plan.action_id is None
    assert action_plan.execution == "blocked"
    assert action_plan.reason == "manual_or_destructive_action"
