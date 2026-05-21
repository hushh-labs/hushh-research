from scripts import eval_pkm_structure_agent as eval_script


def test_persona_chain_keeps_hundred_case_crud_surface():
    prompts = eval_script._build_persona_chain(eval_script.PERSONA_SEEDS[0])

    assert len(prompts) == 100
    categories = {prompt.category for prompt in prompts}
    assert {"correction", "deletion", "ambiguous", "finance"}.issubset(categories)


def test_quality_gate_flags_fallback_fragmentation_and_mutation_drift():
    gate = eval_script._build_quality_gate(
        synthetic_reports=[
            {
                "mode": "candidate_minimal",
                "summary": {
                    "schema_ok_rate": 1.0,
                    "domain_ok_rate": 0.96,
                    "mutation_ok_rate": 0.80,
                    "intent_ok_rate": 0.93,
                    "fallback_rate": 0.25,
                    "fragmentation_score": 0.50,
                    "finance_contamination_count": 1,
                    "unresolved_domain_count": 1,
                },
            }
        ],
        shadow_reports=[],
        thresholds={
            "schema_ok_rate": 1.0,
            "domain_ok_rate": 0.95,
            "mutation_ok_rate": 0.90,
            "intent_ok_rate": 0.90,
            "fallback_rate": 0.10,
            "fragmentation_score_min": 0.80,
            "fragmentation_score_max": 1.20,
        },
    )

    assert gate["status"] == "fail"
    failures = "\n".join(gate["failures"])
    assert "mutation" in failures
    assert "fallback" in failures
    assert "fragmentation" in failures
    assert "finance_contamination" in failures
    assert "unresolved_domain" in failures
