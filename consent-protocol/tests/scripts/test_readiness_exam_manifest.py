"""The readiness exam manifest is the single, truthful source of what UAT grades."""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path

import pytest

from scripts.readiness_exam_manifest import (
    BACKEND_ROOT,
    MANIFEST_PATH,
    anchor_errors,
    anchor_text,
    cases_for_paths,
    coverage_errors,
    load_manifest,
    planner_cases,
    repository_errors,
    resolve_config_ref,
    validate_schema,
)

REPO_ROOT = BACKEND_ROOT.parent
DOCUMENTS = "consent-protocol/hushh_mcp/agents/documents/agent.yaml"
TAVILY = "consent-protocol/hushh_mcp/one_adk/tavily_search.py"
MARKER_LINE = "    # graded by readiness exam: drive_planner.ordinary, drive_planner.explicit\n"


def _manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _anchored_repo(tmp_path: Path, documents_text: str | None = None) -> tuple[dict, Path]:
    """A minimal repository holding only the anchored files, plus the anchored cases."""
    for relative in (DOCUMENTS, TAVILY):
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO_ROOT / relative, target)
    if documents_text is not None:
        (tmp_path / DOCUMENTS).write_text(documents_text, encoding="utf-8")
    manifest = _manifest()
    manifest["cases"] = [case for case in manifest["cases"] if case["anchors"]]
    return manifest, tmp_path


def test_manifest_matches_the_repository():
    assert repository_errors(_manifest(), REPO_ROOT) == []


def test_planner_inputs_are_the_cases_uat_qualified():
    # Characterization: the inputs UAT run 40966814732 graded on 8ba5842e3f.
    assert planner_cases(load_manifest()) == [
        ("ordinary", "resume consist Cedar Rowan Vale"),
        (
            "explicit",
            'Filename exactly "Research Charter.pdf", exclude drafts. Created only within the selected period.',
        ),
    ]


def test_marked_anchors_pass_in_isolation(tmp_path):
    # Positive control for the fixtures below.
    manifest, root = _anchored_repo(tmp_path)
    assert anchor_errors(manifest, root) == []


def test_anchored_instruction_without_its_marker_is_rejected(tmp_path):
    text = (REPO_ROOT / DOCUMENTS).read_text(encoding="utf-8")
    assert MARKER_LINE in text
    manifest, root = _anchored_repo(tmp_path, text.replace(MARKER_LINE, "", 1))
    errors = anchor_errors(manifest, root)
    assert any("marker" in error and "drive_planner.explicit" in error for error in errors)


def test_marker_naming_the_wrong_cases_is_rejected(tmp_path):
    text = (REPO_ROOT / DOCUMENTS).read_text(encoding="utf-8")
    wrong = MARKER_LINE.replace(", drive_planner.explicit", "")
    manifest, root = _anchored_repo(tmp_path, text.replace(MARKER_LINE, wrong, 1))
    assert any("required" in error for error in anchor_errors(manifest, root))


def test_marker_inside_the_instruction_text_is_rejected(tmp_path):
    # A comment inside the block scalar would become prompt text; it never counts.
    text = (REPO_ROOT / DOCUMENTS).read_text(encoding="utf-8")
    moved = text.replace(
        MARKER_LINE + "    system_instruction: |\n",
        "    system_instruction: |\n" + "  " + MARKER_LINE,
        1,
    )
    assert moved != text
    manifest, root = _anchored_repo(tmp_path, moved)
    errors = anchor_errors(manifest, root)
    assert any("required" in error for error in errors)
    assert any("does not belong" in error for error in errors)


def test_stray_marker_on_unmanifested_text_is_rejected(tmp_path):
    text = (REPO_ROOT / DOCUMENTS).read_text(encoding="utf-8")
    stray = text.replace(
        "    description:", "    # graded by readiness exam: unknown.case\n    description:", 1
    )
    manifest, root = _anchored_repo(tmp_path, stray)
    assert any("does not belong" in error for error in anchor_errors(manifest, root))


def test_missing_required_capability_case_is_rejected():
    manifest = _manifest()
    config = json.loads((REPO_ROOT / manifest["provider_config"]).read_text(encoding="utf-8"))
    manifest["cases"] = [
        case for case in manifest["cases"] if case["id"] != "capability.one_text_root"
    ]
    assert any("one_text_root" in error for error in coverage_errors(manifest, REPO_ROOT, config))


def test_unresolved_provider_reference_is_rejected():
    config = json.loads((REPO_ROOT / _manifest()["provider_config"]).read_text(encoding="utf-8"))
    assert resolve_config_ref(config, "pwm_research_uat.azure.primary_deployment")
    with pytest.raises(KeyError):
        resolve_config_ref(config, "pwm_research_uat.azure.primary_deploymnt")


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda m: m["cases"].append(copy.deepcopy(m["cases"][0])), "unique"),
        (lambda m: m["cases"][-1].update(pre_merge="live"), "live pre-merge"),
        (
            lambda m: next(c for c in m["cases"] if c["id"] == "drive_planner.ordinary").pop(
                "input"
            ),
            "input.probe_case",
        ),
        (
            lambda m: next(c for c in m["cases"] if c["id"] == "drive_planner.ordinary").update(
                anchors=[]
            ),
            "exact",
        ),
    ],
)
def test_invalid_manifest_shapes_are_rejected(mutate, expected):
    manifest = _manifest()
    assert validate_schema(manifest) == []
    mutate(manifest)
    assert any(expected in error for error in validate_schema(manifest))


def test_affected_cases_follow_anchors_and_code_paths():
    manifest = _manifest()
    assert cases_for_paths(manifest, [DOCUMENTS]) == [
        "drive_planner.ordinary",
        "drive_planner.explicit",
    ]
    assert {"transport.tavily_search", "pwm.confirmed_guidance"} <= set(
        cases_for_paths(manifest, [TAVILY])
    )
    assert cases_for_paths(manifest, ["README.md"]) == []


def _anchor(case_id: str) -> dict:
    return next(case for case in _manifest()["cases"] if case["id"] == case_id)["anchors"][0]


def test_anchor_text_reads_instructions_as_data():
    import yaml

    from hushh_mcp.one_adk.tavily_search import QUERY_INSTRUCTION

    source = (REPO_ROOT / DOCUMENTS).read_text(encoding="utf-8")
    subagents = yaml.safe_load(source)["subagents"]
    expected = next(s for s in subagents if s["id"] == "agent_documents_request_search")[
        "system_instruction"
    ]
    assert anchor_text(_anchor("drive_planner.ordinary"), source) == expected
    assert "Apply this same core-name rule" in expected
    tavily = (REPO_ROOT / TAVILY).read_text(encoding="utf-8")
    assert anchor_text(_anchor("pwm.confirmed_guidance"), tavily) == QUERY_INSTRUCTION


def test_anchor_text_refuses_missing_or_non_literal_anchors():
    source = (REPO_ROOT / DOCUMENTS).read_text(encoding="utf-8")
    with pytest.raises(KeyError):
        anchor_text({**_anchor("drive_planner.ordinary"), "subagent": "agent_missing"}, source)
    with pytest.raises(ValueError):
        anchor_text(_anchor("pwm.confirmed_guidance"), "QUERY_INSTRUCTION = build_prompt()\n")


def test_planner_case_subset_is_deterministic():
    manifest = load_manifest()
    assert planner_cases(manifest, ["drive_planner.explicit"]) == [planner_cases(manifest)[1]]
    assert planner_cases(manifest, []) == []
