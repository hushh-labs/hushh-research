"""The classifier's instructions must not contradict themselves.

A prompt is a harness. When it states a rule and then shows an example breaking
it, the model does not average the two -- it follows whichever is nearer the
decision, and the behaviour becomes unreproducible. These are the five
contradictions this prompt actually contained, each pinned so it cannot return.

Nothing here asserts prose style. Every assertion is a rule and an example that
must agree with each other.
"""

import re

from hushh_mcp.services.domain_contracts import CANONICAL_DOMAIN_KEYS
from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService


def build_prompt() -> str:
    service = PKMAgentLabService()
    return service._build_structure_prompt(  # noqa: SLF001 - the prompt IS the contract
        message="I gravitate toward Cantonese menus when I go out.",
        current_domains=["food"],
        registry_choices=[{"domain_key": "food"}],
        simulated_state={},
        financial_guard={"routing_decision": "none"},
        intent_frame={"save_class": "durable", "requires_confirmation": False},
        merge_decision={"target_domain": "food"},
        strict_small_model=False,
    )


def test_it_does_not_forbid_can_save_and_then_offer_it():
    # The rule said "Every durable write is confirm_first; never rely on
    # can_save", and an example then said "write_mode can_save or
    # confirm_first". A model reading both has no rule at all.
    prompt = build_prompt()
    assert "never rely on can_save for persistence" in prompt
    assert "write_mode can_save or confirm_first" not in prompt


def test_examples_do_not_teach_create_domain_for_a_domain_that_exists():
    # Both worked examples said action "create_domain" with target_domain "food"
    # and "social", which are canonical and already exist. That collapses the
    # distinction between the three actions the prompt allows.
    prompt = build_prompt()
    for match in re.finditer(r'"action":"create_domain","target_domain":"([a-z_]+)"', prompt):
        assert match.group(1) not in CANONICAL_DOMAIN_KEYS, (
            f"example teaches create_domain for {match.group(1)}, which already exists"
        )


def test_the_three_actions_are_defined_not_only_demonstrated():
    prompt = build_prompt()
    for action in ("match_existing_domain", "extend_domain", "create_domain"):
        assert action in prompt


def test_one_prompt_states_one_contract_version():
    prompt = build_prompt()
    versions = set(re.findall(r'"contract_version":(\d+)', prompt))
    assert len(versions) <= 1, f"examples disagree on contract_version: {sorted(versions)}"


def test_examples_agree_on_what_is_externalizable():
    # One example marked only the leaf; the other marked its containers too.
    # Only leaves are ever externalizable, so the second taught the wrong rule.
    prompt = build_prompt()
    for match in re.finditer(r'"externalizable_paths":\[([^\]]*)\]', prompt):
        paths = re.findall(r'"([^"]+)"', match.group(1))
        for path in paths:
            assert not any(other != path and other.startswith(f"{path}.") for other in paths), (
                f"{path} is a container, not a leaf, yet is listed as externalizable"
            )
