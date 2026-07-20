from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services.agent_chat_service import (
    AGENT_SYSTEM_PROMPT,
    AgentChatActionPlan,
    AgentChatMessage,
    AgentChatService,
    AgentRuntimeContractError,
    RuntimeSecretSession,
    _current_screen_from_context,
    _enrich_plan_with_manifest,
    _runtime_provider_error_from_exception,
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

    assert service.model == "gemini-3.5-flash"


def test_agent_chat_service_ignores_env_model_override(monkeypatch, test_vault_key):
    monkeypatch.setenv("AGENT_GEMINI_MODEL", "gemini-env-override")

    service = AgentChatService(vault_key_hex=test_vault_key)

    assert service.model == "gemini-3.5-flash"


def test_agent_chat_runtime_contract_defaults_to_hushh_managed(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    contract = service.prepare_runtime_contract()

    assert contract.mode == "hushh_managed_vertex"
    assert contract.credential_supplied is False


def test_agent_chat_runtime_contract_accepts_byok_with_runtime_credential(
    test_vault_key,
):
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


def test_agent_chat_runtime_contract_accepts_a_vertex_api_key_with_explicit_endpoint(
    test_vault_key,
):
    service = AgentChatService(vault_key_hex=test_vault_key)

    contract = service.prepare_runtime_contract(
        runtime_credential="USER_VERTEX_KEY",
        runtime_credential_mode="byok",
        runtime_credential_transport="vertex_api_key",
        runtime_vertex_project="customer-vertex-project",
        runtime_vertex_location="us-central1",
    )

    assert contract.gemini_byok_transport == "vertex_api_key"
    assert contract.vertex_project == "customer-vertex-project"
    assert contract.vertex_location == "us-central1"


def test_agent_chat_runtime_contract_rejects_vertex_key_without_endpoint_metadata(test_vault_key):
    service = AgentChatService(vault_key_hex=test_vault_key)

    with pytest.raises(AgentRuntimeContractError, match="Google Cloud Vertex") as error:
        service.prepare_runtime_contract(
            runtime_credential="USER_VERTEX_KEY",
            runtime_credential_mode="byok",
            runtime_credential_transport="vertex_api_key",
        )

    assert error.value.error_code == "AGENT_RUNTIME_VERTEX_CONFIGURATION_INVALID"


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
    monkeypatch.setattr("google.genai.Client", fake_client)
    service = AgentChatService(vault_key_hex=test_vault_key)

    prepared = await service.prepare_agent_runtime(
        runtime_credential=sample_runtime_value,
        runtime_credential_mode="byok",
    )

    assert prepared.mode == "byok"
    assert prepared.model == "gemini-3.5-flash"
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

    monkeypatch.setattr("google.genai.Client", fake_client)

    client = create_runtime_client("gemini", " USER_BYOK_KEY ")

    assert client.kind == "client"
    assert calls == [{"vertexai": False, "api_key": "USER_BYOK_KEY"}]


def test_create_managed_runtime_client_uses_vertex_adc(monkeypatch):
    calls: list[dict] = []

    def fake_client(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(kind="client")

    monkeypatch.setattr("google.genai.Client", fake_client)
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")

    client = create_managed_runtime_client("gemini", " MANAGED_KEY ")

    assert client.kind == "client"
    assert calls == [{"vertexai": True, "project": "hushh-test", "location": "global"}]


def test_agent_chat_classifies_adc_refresh_failure_as_managed_credentials_unavailable():
    from google.auth.exceptions import RefreshError

    error = _runtime_provider_error_from_exception(RefreshError("reauthentication required"))

    assert error.error_code == "AGENT_RUNTIME_MANAGED_CREDENTIALS_UNAVAILABLE"
    assert error.message == "Hushh managed Gemini is not available in this environment."
    assert error.detail == {
        "error_type": "RefreshError",
        "likely_issue": "managed_google_credentials_unavailable",
        "operator_hint": "Check Hushh managed Gemini credentials for this runtime.",
    }


@pytest.mark.anyio
async def test_prepare_runtime_credentials_resolves_pkm_credential_without_raw_value_in_evidence():
    sample_runtime_key = "USER_KEY_SHOULD_NOT_LEAK"
    runtime = runtime_config(
        "google_adk",
        model=ModelConfig(
            provider="gemini",
            model="gemini-3.1-flash-lite",
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
            model="gemini-3.1-flash-lite",
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
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)
    title = service._encrypt_text("Plan the product launch")
    content = service._encrypt_text("Hello from encrypted history")

    conversation = service._conversation_from_row(
        {
            "id": "conversation-1",
            "user_id": "user-1",
            "title_ciphertext": title.ciphertext,
            "title_iv": title.iv,
            "title_tag": title.tag,
            "model": "gemini-3.5-flash",
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
            "model": "gemini-3.5-flash",
        }
    )

    assert conversation.title == "Plan the product launch"
    assert conversation.message_count == 2
    assert message.content == "Hello from encrypted history"
    assert message.role == "assistant"


@pytest.mark.anyio
async def test_prepare_turn_is_one_transaction_and_history_precedes_current_message(
    test_vault_key,
):
    calls: list[tuple[str, dict]] = []

    class _TransactionalDb:
        def execute_raw(self, sql, params):  # noqa: ANN001
            calls.append((sql, dict(params)))
            return SimpleNamespace(
                data=[
                    {
                        "conversation": {
                            "id": "conversation-1",
                            "user_id": "user-1",
                            "title_ciphertext": params["title_ciphertext"],
                            "title_iv": params["title_iv"],
                            "title_tag": params["title_tag"],
                            "model": params["model"],
                            "message_count": 3,
                        },
                        "history": [
                            {
                                "id": "prior-message-1",
                                "conversation_id": "conversation-1",
                                "user_id": "user-1",
                                "role": "assistant",
                                "status": "complete",
                                "content_ciphertext": prior.ciphertext,
                                "content_iv": prior.iv,
                                "content_tag": prior.tag,
                            }
                        ],
                        "user_message": {
                            "id": params["user_message_id"],
                            "conversation_id": "conversation-1",
                            "user_id": "user-1",
                            "role": "user",
                            "status": "complete",
                            "content_ciphertext": params["content_ciphertext"],
                            "content_iv": params["content_iv"],
                            "content_tag": params["content_tag"],
                        },
                    }
                ]
            )

    service = AgentChatService(
        db=_TransactionalDb(), model="gemini-3.5-flash", vault_key_hex=test_vault_key
    )
    prior = service._encrypt_text("Prior assistant answer")

    turn = await service.prepare_turn(
        user_id="user-1",
        conversation_id="conversation-1",
        message="Current user request",
    )

    assert len(calls) == 1
    sql, params = calls[0]
    assert sql.index("recent_rows AS MATERIALIZED") < sql.index("inserted_message AS")
    assert params["requested_conversation_id"] == "conversation-1"
    assert turn.conversation_id == "conversation-1"
    assert turn.history[0].content == "Prior assistant answer"
    assert all(item.content != "Current user request" for item in turn.history)


def test_agent_chat_contents_use_system_instruction_boundary_and_planned_action(
    test_vault_key,
):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)
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
                model="gemini-3.5-flash",
                created_at=None,
                completed_at=None,
            ),
        ],
        action_plan=action_plan,
        pkm_context="Saved domains: Financial\n- Financial: prefers long-term portfolio reviews.",
    )
    current_turn_text = contents[-1].parts[0].text or ""

    assert "You are One, the top private agent" in AGENT_SYSTEM_PROMPT
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


def test_agent_chat_translates_gemini_function_call_to_frontend_analysis(
    test_vault_key,
):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

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


def test_agent_chat_translates_gemini_function_call_to_frontend_navigation(
    test_vault_key,
):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

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
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

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


def test_agent_chat_translates_gemini_crm_update_scope_and_fields(test_vault_key):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

    action_plan = service._action_plan_from_function_call(
        SimpleNamespace(
            id="gemini-call-crm",
            name="propose_crm_update",
            args={
                "target_scope": "all_connected_crm_systems",
                "email": "kushal@example.com",
                "phone": "415-555-1212",
                "additional_fields_json": '{"MailingCity":"Las Vegas"}',
            },
        )
    )

    assert action_plan is not None
    assert action_plan.action_id == "connected_system.crm.update.propose"
    assert action_plan.execution == "frontend"
    assert action_plan.slots["scope"] == "all_connected_crm_systems"
    assert action_plan.slots["email"] == "kushal@example.com"
    assert action_plan.slots["phone"] == "415-555-1212"
    assert action_plan.slots["additionalFieldsJson"] == '{"MailingCity":"Las Vegas"}'


def test_agent_chat_translates_gemini_crm_read_scope(test_vault_key):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

    action_plan = service._action_plan_from_function_call(
        SimpleNamespace(
            id="gemini-call-crm-read",
            name="read_crm_record",
            args={
                "target_scope": "all_connected_crm_systems",
                "email": "kushal@example.com",
                "phone": "415-555-1212",
            },
        )
    )

    assert action_plan is not None
    assert action_plan.action_id == "connected_system.crm.read"
    assert action_plan.slots["scope"] == "all_connected_crm_systems"
    assert action_plan.slots["email"] == "kushal@example.com"
    assert action_plan.slots["phone"] == "415-555-1212"


def test_agent_chat_plans_safe_navigation_actions(test_vault_key):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Can you open the consent center?")

    assert action_plan is not None
    assert action_plan.action_id == "route.consents"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_plans_explicit_pkm_add(test_vault_key):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

    action_plan = service.plan_action(
        "Can you add this information in my PKM: my name is Akshat Kumar."
    )

    assert action_plan is not None
    assert action_plan.action_id == "pkm.add"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_plans_pkm_navigation(test_vault_key):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Please open my PKM memory lab")

    assert action_plan is not None
    assert action_plan.action_id == "route.profile_pkm_agent_lab"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_prefers_import_over_dashboard_for_portfolio_import(test_vault_key):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Please open portfolio import")

    assert action_plan is not None
    assert action_plan.action_id == "route.kai_import"
    assert action_plan.execution == "frontend"
    assert action_plan.slots == {}


def test_agent_chat_blocks_destructive_actions(test_vault_key):
    service = AgentChatService(model="gemini-3.5-flash", vault_key_hex=test_vault_key)

    action_plan = service.plan_action("Delete my account and all vault data")

    assert action_plan is not None
    assert action_plan.action_id is None
    assert action_plan.execution == "blocked"
    assert action_plan.reason == "manual_or_destructive_action"


def test_current_screen_from_context_reads_voice_shape():
    assert _current_screen_from_context(None) is None
    assert _current_screen_from_context({}) is None
    assert (
        _current_screen_from_context({"route": {"screen": "marketplace_ria_profile"}})
        == "marketplace_ria_profile"
    )
    assert _current_screen_from_context({"surface": {"screen_id": "kai_home"}}) == "kai_home"


def test_enrich_plan_with_manifest_flags_manual_only_and_reachability():
    plan = AgentChatActionPlan(
        call_id="tool_1",
        action_id="analysis.cancel_active",
        label="Cancel Active Analysis Run",
        execution="frontend",
        slots={},
        message="Requesting advisory access.",
    )

    enriched = _enrich_plan_with_manifest(plan, current_screen="kai_analysis")

    assert enriched.execution_policy == "manual_only"
    assert enriched.requires_confirmation is True
    assert enriched.reachable is True

    payload = enriched.to_event_payload()
    assert payload["execution_policy"] == "manual_only"
    assert payload["requires_confirmation"] is True
    assert payload["reachable"] is True


def test_enrich_plan_with_manifest_marks_unreachable_off_screen():
    plan = AgentChatActionPlan(
        call_id="tool_2",
        action_id="analysis.cancel_active",
        label="Cancel Active Analysis Run",
        execution="frontend",
        slots={},
        message="Requesting advisory access.",
    )

    enriched = _enrich_plan_with_manifest(plan, current_screen="kai_home")

    assert enriched.reachable is False


def test_enrich_plan_with_manifest_degrades_on_unknown_action():
    plan = AgentChatActionPlan(
        call_id="tool_3",
        action_id="not.a.real.action",
        label="Unknown",
        execution="frontend",
        slots={},
        message="Doing something.",
    )

    enriched = _enrich_plan_with_manifest(plan, current_screen="kai_home")

    assert enriched.execution_policy is None
    assert enriched.requires_confirmation is False
    assert enriched.reachable is None
    assert "execution_policy" not in enriched.to_event_payload()


def test_enrich_plan_with_manifest_unknown_screen_leaves_reachability_unknown():
    plan = AgentChatActionPlan(
        call_id="tool_4",
        action_id="analysis.cancel_active",
        label="Cancel Active Analysis Run",
        execution="frontend",
        slots={},
        message="Requesting advisory access.",
    )

    enriched = _enrich_plan_with_manifest(plan, current_screen=None)

    assert enriched.execution_policy == "manual_only"
    assert enriched.reachable is None
