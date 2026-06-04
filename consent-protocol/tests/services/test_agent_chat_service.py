from __future__ import annotations

from types import SimpleNamespace

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
