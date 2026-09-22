"""The structure agent's answer survives the pipeline that asked for it.

`_STRUCTURE_DECISION_SCHEMA` marks ten fields `required`, so a response missing
any one of them is rejected and retried. Six of those ten were then discarded:
`_normalize_structure_preview` called `_fallback_structure_decision` with no
guard and rebuilt `action`, `json_paths`, `top_level_scope_paths`,
`externalizable_paths`, `summary_projection` and `sensitivity_labels` from a
deterministic walk, every time, including on a perfectly successful call.

That is the shape AGENTS.md principle 9 calls *discards*: the model is paid
for, prompted, schema-constrained and then overruled by a rule. These tests
hold the repaired boundary in place.

Two fields stay walk-derived, and that is not a compromise. `candidate_payload`
is mutated after the model returns -- sanitized, CRUD-realigned, financially
normalized, root-scope retargeted, metadata-stripped -- so the model's
`json_paths` describe a payload that no longer exists. Recording them would be
a lie about what was written, not deference.
"""

from __future__ import annotations

from hushh_mcp.services.pkm_agent_lab_service import (
    _STRUCTURE_DECISION_ACTIONS,
    _STRUCTURE_DECISION_SCHEMA,
    PKMAgentLabService,
)
from tests.services.test_pkm_agent_lab_service import _registry_choices

WALK = {
    "action": "extend_domain",
    "target_domain": "preferences",
    "json_paths": ["preferences", "preferences.tone", "preferences.style"],
    "top_level_scope_paths": ["preferences"],
    "externalizable_paths": ["preferences.tone", "preferences.style"],
    "sensitivity_labels": {"preferences.tone": "standard"},
    "summary_projection": {"intent_class": "note", "path_count": 3},
}


def _adopt(raw: dict) -> tuple[dict, list[str]]:
    return PKMAgentLabService._adopt_model_structure_decision(
        walk_decision=dict(WALK), raw_decision=raw
    )


class TestTheModelDecides:
    def test_a_new_domain_is_the_models_call_not_the_rules(self):
        # The founder's measured case. The walk says extend_domain because the
        # target already exists in current_domains; the model looked at the
        # sentence and said this is a subject area of its own. The model wins.
        decision, hints = _adopt({"action": "create_domain"})
        assert decision["action"] == "create_domain"
        assert hints == []

    def test_the_model_chooses_what_is_shareable(self):
        decision, _ = _adopt({"externalizable_paths": ["preferences.tone"]})
        # Not both leaves, which is what the walk would have offered.
        assert decision["externalizable_paths"] == ["preferences.tone"]

    def test_a_label_the_model_wrote_is_kept(self):
        # Every one of these was `null` in the stored manifest, for 47 leaves
        # including student debt and home address, because the walk had no
        # opinion and overwrote the one that did.
        decision, _ = _adopt({"sensitivity_labels": {"preferences.style": "confidential"}})
        assert decision["sensitivity_labels"]["preferences.style"] == "confidential"
        # And it does not erase what the walk already knew.
        assert decision["sensitivity_labels"]["preferences.tone"] == "standard"

    def test_the_models_projection_is_kept_but_the_count_is_a_fact(self):
        decision, _ = _adopt(
            {"summary_projection": {"intent_class": "preference", "top_level_scope": "preferences"}}
        )
        assert decision["summary_projection"]["intent_class"] == "preference"
        assert decision["summary_projection"]["top_level_scope"] == "preferences"
        # A count is not a judgement. It describes the payload, so it is taken
        # from the payload -- a model-supplied count that disagreed would make
        # the manifest describe a shape nothing was written in.
        assert decision["summary_projection"]["path_count"] == 3


class TestTheWalkStillGuards:
    def test_paths_the_mutations_removed_do_not_survive(self):
        decision, hints = _adopt(
            {
                "externalizable_paths": ["gone.entirely", "also.gone"],
                "sensitivity_labels": {"gone.entirely": "confidential"},
            }
        )
        assert decision["externalizable_paths"] == WALK["externalizable_paths"]
        assert "structure_externalizable_paths_stale" in hints
        assert "structure_sensitivity_labels_stale" in hints
        assert "gone.entirely" not in decision["sensitivity_labels"]

    def test_a_partial_survival_is_visible_rather_than_silent(self):
        decision, hints = _adopt({"externalizable_paths": ["preferences.tone", "gone.entirely"]})
        assert decision["externalizable_paths"] == ["preferences.tone"]
        # A rising rate here means the prompt and the normalization steps
        # disagree about the payload's shape, which is a prompt defect. It has
        # to be observable to be fixable.
        assert "structure_externalizable_paths_partially_stale" in hints

    def test_an_action_outside_the_schema_is_refused_and_named(self):
        decision, hints = _adopt({"action": "invent_a_domain"})
        assert decision["action"] == WALK["action"]
        assert "structure_action_invalid" in hints

    def test_json_paths_are_never_taken_from_the_model(self):
        # The one thing adoption must not do. These describe the payload after
        # five mutation steps the model never saw.
        decision, _ = _adopt(
            {"json_paths": ["something.else"], "top_level_scope_paths": ["something"]}
        )
        assert decision["json_paths"] == WALK["json_paths"]
        assert decision["top_level_scope_paths"] == WALK["top_level_scope_paths"]

    def test_an_empty_decision_leaves_the_walk_untouched(self):
        # A failed or skipped model call. The fallback IS the answer here, and
        # that remains correct -- principle 9's stated exception.
        decision, hints = _adopt({})
        assert decision == WALK
        assert hints == []


class TestTheContractCannotDrift:
    def test_the_enum_and_the_adoption_path_share_one_source(self):
        assert _STRUCTURE_DECISION_SCHEMA["properties"]["action"]["enum"] == sorted(
            _STRUCTURE_DECISION_ACTIONS
        )

    def test_every_adopted_field_is_one_the_schema_demands(self):
        required = set(_STRUCTURE_DECISION_SCHEMA["required"])
        for field in ("action", "externalizable_paths", "summary_projection", "sensitivity_labels"):
            assert field in required, field


class TestTheAdoptionIsActuallyWiredIn:
    """The method existing is not the method running.

    Written because disabling adoption at its call site left all 61 existing
    tests in `test_pkm_agent_lab_service.py` green, and the unit tests above
    green too, since they call `_adopt_model_structure_decision` directly. A
    stage that exists and is never invoked is the exact defect this whole
    change is about, so it needs a test that goes through the front door.
    """

    @staticmethod
    def _preview(structure_decision: dict) -> dict:
        return PKMAgentLabService._normalize_structure_preview(
            message="I write in short declarative sentences and hate filler.",
            current_domains=["food"],
            registry_choices=_registry_choices(),
            intent_frame={
                "intent_class": "preference",
                "mutation_intent": "create",
                "confidence": 0.9,
                "candidate_domain_choices": [{"domain_key": "food", "recommended": True}],
            },
            merge_decision={"target_domain": "food", "merge_mode": "create_entity"},
            financial_guard={"routing_decision": "non_financial_or_ephemeral"},
            parsed_structure={
                "candidate_payload": {"preferences": {"tone": "short and declarative"}},
                "structure_decision": structure_decision,
                "write_mode": "can_save",
                "target_entity_scope": "preferences",
                "validation_hints": [],
            },
            fallback_target_domain="food",
            simulated_state=None,
        )

    def test_the_models_action_reaches_the_preview(self):
        # `food` is in current_domains and the intent is `create`, so the walk
        # would say extend_domain. The model says otherwise and is heard.
        preview = self._preview(
            {
                "action": "create_domain",
                "target_domain": "food",
                "externalizable_paths": ["preferences.tone"],
                "summary_projection": {},
                "sensitivity_labels": {},
                "confidence": 0.9,
                "source_agent": "pkm_structure_agent",
                "contract_version": 3,
            }
        )
        assert preview["structure_decision"]["action"] == "create_domain"

    def test_the_models_sensitivity_label_reaches_the_preview(self):
        preview = self._preview(
            {
                "action": "extend_domain",
                "target_domain": "food",
                "externalizable_paths": ["preferences.tone"],
                "summary_projection": {},
                "sensitivity_labels": {"preferences.tone": "confidential"},
                "confidence": 0.9,
                "source_agent": "pkm_structure_agent",
                "contract_version": 3,
            }
        )
        labels = preview["structure_decision"]["sensitivity_labels"]
        assert labels.get("preferences.tone") == "confidential"
