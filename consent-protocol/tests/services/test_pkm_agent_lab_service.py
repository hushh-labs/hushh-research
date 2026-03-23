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
            "domain_key": "health",
            "display_name": "Health",
            "description": "Durable health routines, constraints, and wellness preferences",
        },
        {
            "domain_key": "financial",
            "display_name": "Financial",
            "description": "Investment portfolio, risk profile, and financial preferences",
        },
    ]


def _single_segment(message: str):
    return {
        "segments": [
            {
                "source_text": message,
                "confidence": 0.99,
                "reason": "Single coherent PKM memory candidate.",
            }
        ],
        "source_agent": "memory_segmentation_agent",
        "contract_version": 1,
    }


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
            _single_segment("I like Chinese"),
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
    assert run_agent_contract.await_count == 5
    assert len(result["preview_cards"]) == 1
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
            _single_segment("Remind me to call mom on Sunday"),
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
    assert run_agent_contract.await_count == 3
    assert result["preview_summary"]["do_not_save_count"] == 1
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
            _single_segment("I want a lower-volatility portfolio."),
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
    assert run_agent_contract.await_count == 2
    assert result["preview_cards"][0]["write_mode"] == "do_not_save"
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
            _single_segment("Remember that I prefer index funds"),
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
    assert run_agent_contract.await_count == 4
    assert result["preview_cards"][0]["target_domain"] == "financial"


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
            _single_segment("Cantonese menus are usually where I start"),
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
    assert run_agent_contract.await_count == 5
    assert result["preview_cards"][0]["primary_json_path"] == "preferences"


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
            _single_segment("Q2FmZSB3YWtlIHVwIGhhc2ggcGF5bG9hZA=="),
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
    assert run_agent_contract.await_count == 3
    assert result["preview_cards"][0]["write_mode"] == "do_not_save"


@pytest.mark.asyncio
async def test_generate_structure_preview_splits_multi_intent_into_cards(monkeypatch):
    service = PKMAgentLabService()

    monkeypatch.setattr(
        service,
        "_load_domain_registry_choices",
        AsyncMock(return_value=_registry_choices()),
    )
    run_agent_contract = AsyncMock(
        side_effect=[
            {
                "segments": [
                    {
                        "source_text": "I prefer to go to gym in the morning around 7am.",
                        "confidence": 0.93,
                        "reason": "Routine memory.",
                    },
                    {
                        "source_text": "I like to have a good breakfast too.",
                        "confidence": 0.81,
                        "reason": "Second food-related preference.",
                    },
                ],
                "source_agent": "memory_segmentation_agent",
                "contract_version": 1,
            },
            {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.91,
                "reason": "Routine memory.",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            },
            {
                "save_class": "durable",
                "intent_class": "routine",
                "mutation_intent": "create",
                "requires_confirmation": False,
                "confirmation_reason": "",
                "candidate_domain_choices": [
                    {"domain_key": "health", "recommended": True},
                    {"domain_key": "food", "recommended": False},
                ],
                "confidence": 0.88,
                "source_agent": "memory_intent_agent",
                "contract_version": 1,
            },
            {
                "merge_mode": "create_entity",
                "target_domain": "health",
                "target_entity_id": "mem_gym_7am",
                "target_entity_path": "routines.entities.mem_gym_7am",
                "match_confidence": 0.83,
                "match_reason": "New morning routine.",
                "source_agent": "memory_merge_agent",
                "contract_version": 1,
            },
            {
                "candidate_payload": {
                    "routines": {
                        "entities": {
                            "mem_gym_7am": {
                                "entity_id": "mem_gym_7am",
                                "kind": "routine",
                                "summary": "I prefer to go to gym in the morning around 7am.",
                                "observations": [
                                    "I prefer to go to gym in the morning around 7am."
                                ],
                                "status": "active",
                            }
                        }
                    }
                },
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "health",
                    "json_paths": [
                        "routines",
                        "routines.entities",
                        "routines.entities.mem_gym_7am",
                        "routines.entities.mem_gym_7am.summary",
                    ],
                    "top_level_scope_paths": ["routines"],
                    "externalizable_paths": [
                        "routines",
                        "routines.entities",
                        "routines.entities.mem_gym_7am",
                        "routines.entities.mem_gym_7am.summary",
                    ],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.9,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": 1,
                },
                "write_mode": "can_save",
                "primary_json_path": "routines",
                "target_entity_scope": "routines",
                "validation_hints": [],
            },
            {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.9,
                "reason": "Food preference.",
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
                    {"domain_key": "health", "recommended": False},
                ],
                "confidence": 0.86,
                "source_agent": "memory_intent_agent",
                "contract_version": 1,
            },
            {
                "merge_mode": "create_entity",
                "target_domain": "food",
                "target_entity_id": "mem_breakfast_pref",
                "target_entity_path": "preferences.entities.mem_breakfast_pref",
                "match_confidence": 0.8,
                "match_reason": "New breakfast preference.",
                "source_agent": "memory_merge_agent",
                "contract_version": 1,
            },
            {
                "candidate_payload": {
                    "preferences": {
                        "entities": {
                            "mem_breakfast_pref": {
                                "entity_id": "mem_breakfast_pref",
                                "kind": "preference",
                                "summary": "I like to have a good breakfast too.",
                                "observations": ["I like to have a good breakfast too."],
                                "status": "active",
                            }
                        }
                    }
                },
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "food",
                    "json_paths": [
                        "preferences",
                        "preferences.entities",
                        "preferences.entities.mem_breakfast_pref",
                        "preferences.entities.mem_breakfast_pref.summary",
                    ],
                    "top_level_scope_paths": ["preferences"],
                    "externalizable_paths": [
                        "preferences",
                        "preferences.entities",
                        "preferences.entities.mem_breakfast_pref",
                        "preferences.entities.mem_breakfast_pref.summary",
                    ],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.88,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": 1,
                },
                "write_mode": "can_save",
                "primary_json_path": "preferences",
                "target_entity_scope": "preferences",
                "validation_hints": [],
            },
        ]
    )
    monkeypatch.setattr(service, "_run_agent_contract", run_agent_contract)

    result = await service.generate_structure_preview(
        user_id="user-7",
        message="I prefer to go to gym in the morning around 7am and have good breakfast too",
        current_domains=[],
    )

    assert len(result["preview_cards"]) == 2
    assert result["preview_summary"]["card_count"] == 2
    assert result["preview_cards"][0]["target_domain"] == "health"
    assert result["preview_cards"][1]["target_domain"] == "food"
    assert result["context_plan"]["candidate_domains"] == ["health", "food"]
