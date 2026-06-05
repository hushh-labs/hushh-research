from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services.agent_chat_service import (
    AGENT_SYSTEM_PROMPT,
    AgentChatMessage,
    AgentChatService,
    AgentRuntimeContractError,
    RuntimeSecretSession,
    create_managed_runtime_client,
    create_runtime_client,
)
from hussh_sdk import (
    ModelConfig,
    PKMCredentialResolver,
    prepare_runtime_credentials,
    runtime_config,
)


def test_agent_chat_service_uses_agent_yaml_model(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    assert service.model == "gemini-2.5-flash"


def test_agent_chat_service_ignores_env_model_override(monkeypatch, test_vault_key):
    monkeypatch.setenv("AGENT_GEMINI_MODEL", "gemini-env-override")

    service = AgentChatService(vault_key_hex=test_vault_key)

    assert service.model == "gemini-2.5-flash"


def test_agent_chat_runtime_contract_defaults_to_hushh_managed(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    contract = service.prepare_runtime_contract()

    assert contract.mode == "hushh_managed_vertex"
    assert contract.credential_supplied is False


def test_agent_chat_runtime_contract_accepts_byok_with_runtime_credential(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    contract = service.prepare_runtime_contract(
        runtime_credential=" USER_GEMINI_KEY ",
        runtime_credential_mode="byok",
    )

    assert contract.mode == "byok"
    assert contract.credential_supplied is True


def test_agent_chat_runtime_contract_rejects_missing_byok_credential(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    try:
        service.prepare_runtime_contract(
            runtime_credential=" ",
            runtime_credential_mode="byok",
        )
    except AgentRuntimeContractError as error:
        assert error.error_code == "AGENT_RUNTIME_CREDENTIAL_MISSING"
        assert "Gemini key" in error.message
    else:  # pragma: no cover - defensive assertion clarity
        raise AssertionError("Expected AgentRuntimeContractError")


def test_agent_chat_runtime_contract_rejects_invalid_mode(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    try:
        service.prepare_runtime_contract(
            runtime_credential="USER_GEMINI_KEY",
            runtime_credential_mode="unsupported",
        )
    except AgentRuntimeContractError as error:
        assert error.error_code == "AGENT_RUNTIME_MODE_INVALID"
        assert error.message == "Agent runtime credential mode is invalid."
    else:  # pragma: no cover - defensive assertion clarity
        raise AssertionError("Expected AgentRuntimeContractError")


@pytest.mark.anyio
async def test_agent_chat_service_prepares_byok_runtime_from_pkm_secret(
    monkeypatch,
    test_vault_key,
    caplog,
):
    calls: list[dict] = []
    sample_runtime_value = "_".join(["USER", "BYOK", "VALUE", "SHOULD", "NOT", "LEAK"])

    def fake_client(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(kind="client")

    monkeypatch.setenv("GOOGLE_API_KEY", "BACKEND_KEY_SHOULD_NOT_BE_USED")
    monkeypatch.setattr("hushh_mcp.services.agent_chat_service.genai.Client", fake_client)
    service = AgentChatService(vault_key_hex=test_vault_key)

    prepared = await service.prepare_agent_runtime(
        runtime_credential=sample_runtime_value,
        runtime_credential_mode="byok",
    )

    assert prepared.mode == "byok"
    assert prepared.model == "gemini-2.5-flash"
    assert prepared.client.kind == "client"
    assert calls == [{"vertexai": False, "api_key": sample_runtime_value}]
    assert sample_runtime_value not in str(prepared.evidence)
    assert sample_runtime_value not in caplog.text


def test_create_runtime_client_uses_byok_key_without_env_fallback(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setenv("GOOGLE_API_KEY", "BACKEND_KEY_SHOULD_NOT_BE_USED")
    monkeypatch.setenv("GEMINI_API_KEY", "BACKEND_GEMINI_SHOULD_NOT_BE_USED")

    def fake_client(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(kind="client")

    monkeypatch.setattr("hushh_mcp.services.agent_chat_service.genai.Client", fake_client)

    client = create_runtime_client("gemini", " USER_BYOK_KEY ")

    assert client.kind == "client"
    assert calls == [{"vertexai": False, "api_key": "USER_BYOK_KEY"}]


def test_create_managed_runtime_client_uses_vertex_api_key(monkeypatch):
    calls: list[dict] = []

    def fake_client(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(kind="client")

    monkeypatch.setattr("hushh_mcp.services.agent_chat_service.genai.Client", fake_client)

    client = create_managed_runtime_client("gemini", " MANAGED_KEY ")

    assert client.kind == "client"
    assert calls == [{"vertexai": True, "api_key": "MANAGED_KEY"}]


@pytest.mark.anyio
async def test_prepare_runtime_credentials_resolves_pkm_credential_without_raw_value_in_evidence():
    sample_runtime_key = "USER_KEY_SHOULD_NOT_LEAK"
    runtime = runtime_config(
        "google_adk",
        model=ModelConfig(
            provider="gemini",
            model="gemini-2.5-flash",
            mode="byok",
            credential_ref="pkm:runtime_secrets.llm.gemini_api_key",
        ),
    )

    bundle = await prepare_runtime_credentials(
        runtime,
        resolver=PKMCredentialResolver(
            RuntimeSecretSession(
                "pkm:runtime_secrets.llm.gemini_api_key",
                sample_runtime_key,
            )
        ),
    )

    assert bundle.credential is not None
    assert bundle.credential.secret == sample_runtime_key
    assert sample_runtime_key not in str(bundle.evidence)


@pytest.mark.anyio
async def test_prepare_runtime_credentials_fails_on_credential_ref_mismatch():
    runtime = runtime_config(
        "google_adk",
        model=ModelConfig(
            provider="gemini",
            model="gemini-2.5-flash",
            mode="byok",
            credential_ref="pkm:runtime_secrets.llm.gemini_api_key",
        ),
    )

    with pytest.raises(Exception) as exc_info:
        await prepare_runtime_credentials(
            runtime,
            resolver=PKMCredentialResolver(
                RuntimeSecretSession(
                    "pkm:runtime_secrets.llm.other_api_key",
                    "USER_KEY_SHOULD_NOT_LEAK",
                )
            ),
        )

    assert "No runtime credential resolved" in str(exc_info.value)
    assert "USER_KEY_SHOULD_NOT_LEAK" not in str(exc_info.value)


def test_agent_chat_service_decrypts_encrypted_conversation_and_message(test_vault_key):
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)
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
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)
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
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

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
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

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
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

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
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Can you open the consent center?")

    assert action_plan is not None
    assert action_plan.action_id == "route.consents"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_plans_explicit_pkm_add(test_vault_key):
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

    action_plan = service.plan_action(
        "Can you add this information in my PKM: my name is Akshat Kumar."
    )

    assert action_plan is not None
    assert action_plan.action_id == "pkm.add"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_plans_pkm_navigation(test_vault_key):
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Please open my PKM memory lab")

    assert action_plan is not None
    assert action_plan.action_id == "route.profile_pkm_agent_lab"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_prefers_import_over_dashboard_for_portfolio_import(test_vault_key):
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Please open portfolio import")

    assert action_plan is not None
    assert action_plan.action_id == "route.kai_import"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_blocks_destructive_actions(test_vault_key):
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Delete my account and all vault data")

    assert action_plan is not None
    assert action_plan.action_id is None
    assert action_plan.execution == "blocked"
    assert action_plan.reason == "manual_or_destructive_action"
