from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService


def _registry_choices():
    return [
        {
            "domain_key": "food",
            "display_name": "Food & Dining",
            "description": "Dietary preferences, favorite cuisines, and restaurant history",
        },
        {
            "domain_key": "travel",
            "display_name": "Travel",
            "description": "Travel preferences, loyalty programs, and trip history",
        },
        {
            "domain_key": "social",
            "display_name": "Social",
            "description": "Relationships, family context, and social preferences",
        },
        {
            "domain_key": "financial",
            "display_name": "Financial",
            "description": "Investment portfolio, risk profile, and financial preferences",
        },
    ]


@pytest.mark.asyncio
async def test_generate_structure_preview_replaces_non_financial_financial_payload(monkeypatch):
    service = PKMAgentLabService()

    monkeypatch.setattr(
        service,
        "_load_domain_registry_choices",
        AsyncMock(return_value=_registry_choices()),
    )
    run_agent_contract = AsyncMock(
        side_effect=[
            {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.95,
                "reason": "Food preference, not finance.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            },
            {
                "save_class": "durable",
                "intent_class": "preference",
                "mutation_intent": "create",
                "requires_confirmation": False,
                "confirmation_reason": "",
                "candidate_domain_choices": [
                    {"domain_key": "food", "recommended": True},
                    {"domain_key": "travel", "recommended": False},
                ],
                "confidence": 0.93,
                "source_agent": "memory_intent_agent",
                "contract_version": 1,
            },
            {
                "merge_mode": "create_entity",
                "target_domain": "food",
                "target_entity_id": "mem_food_pref",
                "target_entity_path": "preferences.entities.mem_food_pref",
                "match_confidence": 0.88,
                "match_reason": "New durable food preference.",
                "source_agent": "memory_merge_agent",
                "contract_version": 1,
            },
            {
                "candidate_payload": {
                    "profile": {
                        "user_stated_financial_memory": "I like Chinese",
                    }
                },
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "preferences",
                    "json_paths": ["profile", "profile.user_stated_financial_memory"],
                    "top_level_scope_paths": ["profile"],
                    "externalizable_paths": ["profile.user_stated_financial_memory"],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.87,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": 1,
                },
                "write_mode": "can_save",
                "target_entity_scope": "profile",
                "validation_hints": [],
            },
        ]
    )
    monkeypatch.setattr(service, "_run_agent_contract", run_agent_contract)

    result = await service.generate_structure_preview(
        user_id="user-1",
        message="I like Chinese",
        current_domains=["financial"],
    )

    assert result["routing_decision"] == "non_financial_or_ephemeral"
    assert result["intent_frame"]["intent_class"] == "preference"
    assert result["structure_decision"]["target_domain"] == "food"
    assert result["write_mode"] == "confirm_first"
    assert result["primary_json_path"] is None
    assert "non_financial_payload_replaced" in result["validation_hints"]
    assert "user_stated_financial_memory" not in str(result["candidate_payload"])
    assert result["merge_decision"]["target_domain"] == "food"
    assert run_agent_contract.await_count == 4
    assert all(
        entry["domain_key"] != "general"
        for entry in result["intent_frame"]["candidate_domain_choices"]
    )


@pytest.mark.asyncio
async def test_generate_structure_preview_marks_ephemeral_reminder_do_not_save(monkeypatch):
    service = PKMAgentLabService()

    monkeypatch.setattr(
        service,
        "_load_domain_registry_choices",
        AsyncMock(return_value=_registry_choices()),
    )
    run_agent_contract = AsyncMock(
        side_effect=[
            {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.89,
                "reason": "Reminder-like request.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            },
            {
                "save_class": "ephemeral",
                "intent_class": "task_or_reminder",
                "mutation_intent": "no_op",
                "requires_confirmation": False,
                "confirmation_reason": "",
                "candidate_domain_choices": [
                    {"domain_key": "general", "recommended": True},
                ],
                "confidence": 0.98,
                "source_agent": "memory_intent_agent",
                "contract_version": 1,
            },
            {
                "candidate_payload": {
                    "tasks": {
                        "statements": [{"value": "Remind me to call mom on Sunday"}],
                    }
                },
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "general",
                    "json_paths": [
                        "tasks",
                        "tasks.statements",
                        "tasks.statements._items",
                        "tasks.statements._items.value",
                    ],
                    "top_level_scope_paths": ["tasks"],
                    "externalizable_paths": [
                        "tasks",
                        "tasks.statements",
                        "tasks.statements._items",
                        "tasks.statements._items.value",
                    ],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.95,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": 1,
                },
                "write_mode": "can_save",
                "target_entity_scope": "tasks.statements",
                "validation_hints": [],
            },
        ]
    )
    monkeypatch.setattr(service, "_run_agent_contract", run_agent_contract)

    result = await service.generate_structure_preview(
        user_id="user-2",
        message="Remind me to call mom on Sunday",
        current_domains=[],
    )

    assert result["routing_decision"] == "non_financial_or_ephemeral"
    assert result["intent_frame"]["save_class"] == "ephemeral"
    assert result["intent_frame"]["mutation_intent"] == "no_op"
    assert result["write_mode"] == "do_not_save"
    assert result["primary_json_path"] is None
    assert "ephemeral_request_not_saved" in result["validation_hints"]
    assert result["structure_decision"]["target_domain"] != "general"
    assert run_agent_contract.await_count == 2
    assert all(
        entry["domain_key"] != "general"
        for entry in result["intent_frame"]["candidate_domain_choices"]
    )


@pytest.mark.asyncio
async def test_generate_structure_preview_routes_financial_core_out_of_pkm(monkeypatch):
    service = PKMAgentLabService()

    monkeypatch.setattr(
        service,
        "_load_domain_registry_choices",
        AsyncMock(return_value=_registry_choices()),
    )
    run_agent_contract = AsyncMock(
        side_effect=[
            {
                "routing_decision": "financial_core",
                "confidence": 0.94,
                "reason": "Portfolio action request.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            },
        ]
    )
    monkeypatch.setattr(service, "_run_agent_contract", run_agent_contract)

    result = await service.generate_structure_preview(
        user_id="user-3",
        message="I want a lower-volatility portfolio.",
        current_domains=["financial"],
    )

    assert result["routing_decision"] == "financial_core"
    assert result["intent_frame"]["intent_class"] == "financial_event"
    assert result["structure_decision"]["target_domain"] == "financial"
    assert result["write_mode"] == "do_not_save"
    assert result["primary_json_path"] is None
    assert "routed_to_financial_core" in result["validation_hints"]
    assert "events" in result["candidate_payload"]
    assert run_agent_contract.await_count == 1
    assert all(
        entry["domain_key"] != "general"
        for entry in result["intent_frame"]["candidate_domain_choices"]
    )


@pytest.mark.asyncio
async def test_generate_structure_preview_normalizes_sanctioned_financial_memory(monkeypatch):
    service = PKMAgentLabService()

    monkeypatch.setattr(
        service,
        "_load_domain_registry_choices",
        AsyncMock(return_value=_registry_choices()),
    )
    run_agent_contract = AsyncMock(
        side_effect=[
            {
                "routing_decision": "sanctioned_financial_memory",
                "confidence": 0.9,
                "reason": "Stable financial preference.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            },
            {
                "merge_mode": "extend_entity",
                "target_domain": "financial",
                "target_entity_id": "mem_fin_pref",
                "target_entity_path": "events.entities.mem_fin_pref",
                "match_confidence": 0.91,
                "match_reason": "Extend existing financial preference memory.",
                "source_agent": "memory_merge_agent",
                "contract_version": 1,
            },
            {
                "candidate_payload": {
                    "preferences": {
                        "statements": [{"value": "Remember that I prefer index funds"}],
                    }
                },
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "food",
                    "json_paths": [
                        "preferences",
                        "preferences.statements",
                        "preferences.statements._items",
                        "preferences.statements._items.value",
                    ],
                    "top_level_scope_paths": ["preferences"],
                    "externalizable_paths": [
                        "preferences",
                        "preferences.statements",
                        "preferences.statements._items",
                        "preferences.statements._items.value",
                    ],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.66,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": 1,
                },
                "write_mode": "can_save",
                "target_entity_scope": "preferences.statements",
                "validation_hints": [],
            },
        ]
    )
    monkeypatch.setattr(service, "_run_agent_contract", run_agent_contract)

    result = await service.generate_structure_preview(
        user_id="user-4",
        message="Remember that I prefer index funds",
        current_domains=["financial"],
    )

    assert result["routing_decision"] == "sanctioned_financial_memory"
    assert result["intent_frame"]["intent_class"] == "financial_event"
    assert result["structure_decision"]["target_domain"] == "financial"
    assert result["write_mode"] == "can_save"
    assert result["primary_json_path"] == "events"
    assert "financial_target_normalized" in result["validation_hints"]
    assert "financial_payload_normalized" in result["validation_hints"]
    assert "events" in result["candidate_payload"]
    assert result["merge_decision"]["merge_mode"] == "extend_entity"
    assert run_agent_contract.await_count == 3


@pytest.mark.asyncio
async def test_generate_structure_preview_defaults_primary_path_to_root_scope(monkeypatch):
    service = PKMAgentLabService()

    monkeypatch.setattr(
        service,
        "_load_domain_registry_choices",
        AsyncMock(return_value=_registry_choices()),
    )
    run_agent_contract = AsyncMock(
        side_effect=[
            {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.9,
                "reason": "Broad durable preference.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            },
            {
                "save_class": "durable",
                "intent_class": "preference",
                "mutation_intent": "create",
                "requires_confirmation": False,
                "confirmation_reason": "",
                "candidate_domain_choices": [
                    {"domain_key": "food", "recommended": True},
                ],
                "confidence": 0.89,
                "source_agent": "memory_intent_agent",
                "contract_version": 1,
            },
            {
                "merge_mode": "create_entity",
                "target_domain": "food",
                "target_entity_id": "mem_food_pref",
                "target_entity_path": "preferences.entities.mem_food_pref",
                "match_confidence": 0.9,
                "match_reason": "New durable food preference.",
                "source_agent": "memory_merge_agent",
                "contract_version": 1,
            },
            {
                "candidate_payload": {
                    "preferences": {
                        "statements": [{"value": "Cantonese menus are usually where I start"}],
                    }
                },
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "food",
                    "json_paths": [
                        "preferences",
                        "preferences.statements",
                        "preferences.statements._items",
                        "preferences.statements._items.value",
                    ],
                    "top_level_scope_paths": ["preferences"],
                    "externalizable_paths": [
                        "preferences",
                        "preferences.statements",
                        "preferences.statements._items",
                        "preferences.statements._items.value",
                    ],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.91,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": 1,
                },
                "write_mode": "can_save",
                "primary_json_path": "preferences.invalid_child",
                "target_entity_scope": "preferences.invalid_child",
                "validation_hints": [],
            },
        ]
    )
    monkeypatch.setattr(service, "_run_agent_contract", run_agent_contract)

    result = await service.generate_structure_preview(
        user_id="user-5",
        message="Cantonese menus are usually where I start",
        current_domains=[],
    )

    assert result["primary_json_path"] == "preferences"
    assert "primary_path_defaulted_to_root_scope" in result["validation_hints"]
    assert run_agent_contract.await_count == 4


@pytest.mark.asyncio
async def test_generate_structure_preview_rejects_opaque_noise(monkeypatch):
    service = PKMAgentLabService()

    monkeypatch.setattr(
        service,
        "_load_domain_registry_choices",
        AsyncMock(return_value=_registry_choices()),
    )
    run_agent_contract = AsyncMock(
        side_effect=[
            {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.99,
                "reason": "Opaque input.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            },
            {
                "save_class": "durable",
                "intent_class": "note",
                "mutation_intent": "create",
                "requires_confirmation": False,
                "confirmation_reason": "",
                "candidate_domain_choices": [
                    {"domain_key": "professional", "recommended": True},
                ],
                "confidence": 0.4,
                "source_agent": "memory_intent_agent",
                "contract_version": 1,
            },
        ]
    )
    monkeypatch.setattr(service, "_run_agent_contract", run_agent_contract)

    result = await service.generate_structure_preview(
        user_id="user-6",
        message="Q2FmZSB3YWtlIHVwIGhhc2ggcGF5bG9hZA==",
        current_domains=[],
    )

    assert result["intent_frame"]["mutation_intent"] == "no_op"
    assert result["write_mode"] == "do_not_save"
    assert "nonsense_or_opaque_input" in result["validation_hints"]
    assert result["merge_decision"]["merge_mode"] == "no_op"
    assert run_agent_contract.await_count == 2
