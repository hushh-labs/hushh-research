from __future__ import annotations

from hushh_mcp.services.agent_chat_service import (
    AGENT_SYSTEM_PROMPT,
    DEFAULT_AGENT_CHAT_MODEL,
    AgentChatMessage,
    AgentChatService,
)


def test_agent_chat_service_defaults_to_stable_gemini_model(monkeypatch, test_vault_key):
    monkeypatch.delenv("AGENT_GEMINI_MODEL", raising=False)

    service = AgentChatService(vault_key_hex=test_vault_key)

    assert service.model == DEFAULT_AGENT_CHAT_MODEL == "gemini-2.5-pro"


def test_agent_chat_service_allows_env_model_override(monkeypatch, test_vault_key):
    monkeypatch.setenv("AGENT_GEMINI_MODEL", "gemini-2.5-flash")

    service = AgentChatService(vault_key_hex=test_vault_key)

    assert service.model == "gemini-2.5-flash"


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


def test_agent_chat_prompt_is_kai_focused_and_includes_planned_action(test_vault_key):
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)
    action_plan = service.plan_action("Start analysis of Nvidia")
    assert action_plan is not None
    assert action_plan.action_id == "analysis.start"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {"symbol": "NVDA"}

    prompt = service._build_prompt(
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
    )

    assert AGENT_SYSTEM_PROMPT in prompt
    assert "Kai-focused financial assistant" in prompt
    assert "User: Can you help with stocks?" in prompt
    assert "Agent: Yes, I can help with Kai market workflows." in prompt
    assert "Action context:" in prompt
    assert "action_id: analysis.start" in prompt
    assert "slots: {'symbol': 'NVDA'}" in prompt
    assert "User: Start analysis of Nvidia" in prompt


def test_agent_chat_plans_safe_navigation_actions(test_vault_key):
    service = AgentChatService(model="gemini-2.5-pro", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Can you open the consent center?")

    assert action_plan is not None
    assert action_plan.action_id == "route.consents"
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
