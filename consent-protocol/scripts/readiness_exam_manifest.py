"""The single readiness-exam manifest: what the UAT Azure exam runs and grades.

The UAT probe reads its case inputs from the manifest at runtime (JSON only; the
image has no repository root). CI and local runs add the repository checks:
anchors resolve, anchored text carries its marker, and the manifest covers every
required capability and managed text scope. Guardrails: see the manifest's
`guardrails` link.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = BACKEND_ROOT / "config" / "readiness-exam-manifest.v1.json"
SCHEMA_VERSION = "readiness_exam_manifest.v1"
PLANNER_STAGE = "managed_text.activity_planner"
MARKER = "graded by readiness exam:"
KINDS = {"transport", "capability", "semantic"}
PRE_MERGE = {"live", "unit_only"}
ANCHOR_STATUS = {"exact", "composed", "none"}
ANCHOR_FIELDS = {
    "agent_instruction": ("file", "subagent", "field"),
    "python_constant": ("file", "symbol"),
}
CASE_FIELDS = (
    "id",
    "stage",
    "kind",
    "grader",
    "provider",
    "anchor_status",
    "anchors",
    "code_paths",
    "pre_merge",
)
STRUCTURAL_STAGES = {"managed_text", PLANNER_STAGE, "managed_capabilities"}


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Any]:
    manifest: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    errors = validate_schema(manifest)
    if errors:
        raise ValueError("Invalid readiness exam manifest: " + "; ".join(errors))
    return manifest


def planner_cases(
    manifest: dict[str, Any], case_ids: list[str] | None = None
) -> list[tuple[str, str]]:
    """The activity planner's (probe case, purpose) inputs, in manifest order.

    `case_ids` deterministically selects a subset (for a targeted exam); None keeps all.
    """
    return [
        (case["input"]["probe_case"], case["input"]["purpose"])
        for case in manifest["cases"]
        if case["stage"] == PLANNER_STAGE and (case_ids is None or case["id"] in case_ids)
    ]


def anchor_text(anchor: dict[str, str], source_text: str) -> str:
    """The anchored instruction text, read from file content as data (never imported).

    agent_instruction: YAML-parsed (`yaml.safe_load`, imported lazily so this module
    stays stdlib-only at load). python_constant: `ast` plus `literal_eval`.
    """
    if anchor["type"] == "python_constant":
        for node in ast.parse(source_text).body:
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == anchor["symbol"]
                for target in node.targets
            ):
                value = ast.literal_eval(node.value)
                if not isinstance(value, str):
                    raise ValueError(f"{anchor['symbol']} is not a string literal")
                return value
        raise KeyError(anchor["symbol"])
    import yaml  # type: ignore[import-untyped]  # noqa: PLC0415 - optional at module load by design

    document = yaml.safe_load(source_text)
    for subagent in document.get("subagents", []):
        if subagent.get("id") == anchor["subagent"]:
            value = subagent.get(anchor["field"])
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{anchor['subagent']}.{anchor['field']} is empty")
            return value
    raise KeyError(anchor["subagent"])


def _case_errors(case: dict[str, Any]) -> list[str]:
    cid = case.get("id", "<missing id>")
    missing = [field for field in CASE_FIELDS if field not in case]
    if missing:
        return [f"{cid}: missing {', '.join(missing)}"]
    errors = []
    if case["kind"] not in KINDS or case["pre_merge"] not in PRE_MERGE:
        errors.append(f"{cid}: unknown kind or pre_merge")
    if case["anchor_status"] not in ANCHOR_STATUS or ":" not in case["grader"]:
        errors.append(f"{cid}: unknown anchor_status or grader without :symbol")
    if (case["anchor_status"] == "exact") != bool(case["anchors"]):
        errors.append(f"{cid}: exact anchor_status requires anchors, others none")
    if case["pre_merge"] == "live" and (
        case["kind"] != "semantic" or case["anchor_status"] != "exact"
    ):
        errors.append(f"{cid}: a live pre-merge case must be semantic with exact anchors")
    for anchor in case["anchors"]:
        required = ANCHOR_FIELDS.get(anchor.get("type"))
        if required is None or any(not anchor.get(field) for field in required):
            errors.append(f"{cid}: malformed anchor {anchor}")
    if case["stage"] == PLANNER_STAGE and not (
        isinstance(case.get("input"), dict)
        and case["input"].get("probe_case")
        and case["input"].get("purpose")
    ):
        errors.append(f"{cid}: planner case needs input.probe_case and input.purpose")
    return errors


def validate_schema(manifest: Any) -> list[str]:
    if not isinstance(manifest, dict) or manifest.get("schema_version") != SCHEMA_VERSION:
        return [f"schema_version must be {SCHEMA_VERSION}"]
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        return ["cases must be a non-empty list"]
    errors = [error for case in cases for error in _case_errors(case)]
    ids = [case.get("id") for case in cases]
    if len(ids) != len(set(ids)):
        errors.append("case ids must be unique")
    return errors


def resolve_config_ref(config: dict[str, Any], ref: str) -> Any:
    value: Any = config
    for part in ref.split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(ref)
        value = value[part]
    return value


def _module_symbols(source: str) -> set[str]:
    names = set()
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(target.id for target in node.targets if isinstance(target, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def marker_ids(lines: list[str], index: int) -> set[str] | None:
    """Case ids from the marker comment directly above line `index`, if any."""
    cursor = index - 1
    while cursor >= 0 and lines[cursor].strip().startswith("#"):
        text = lines[cursor].strip().lstrip("#").strip()
        if text.startswith(MARKER):
            return {part.strip() for part in text[len(MARKER) :].split(",") if part.strip()}
        cursor -= 1
    return None


def anchor_line(text: str, anchor: dict[str, str]) -> int | None:
    """Zero-based line of the anchored field or constant, or None if absent."""
    lines = text.splitlines()
    if anchor["type"] == "python_constant":
        pattern = re.compile(rf"^{re.escape(anchor['symbol'])}\s*(:[^=]+)?=")
        return next((i for i, line in enumerate(lines) if pattern.match(line)), None)
    start = next(
        (
            i
            for i, line in enumerate(lines)
            if re.match(rf"^\s*- id:\s*{re.escape(anchor['subagent'])}\s*$", line)
        ),
        None,
    )
    if start is None:
        return None
    for i in range(start + 1, len(lines)):
        if re.match(r"^\s*- id:\s*\S", lines[i]):
            return None
        if re.match(rf"^\s+{re.escape(anchor['field'])}:", lines[i]):
            return i
    return None


def anchor_errors(manifest: dict[str, Any], repo_root: Path) -> list[str]:
    errors = []
    expected: dict[tuple[str, int], set[str]] = {}
    for case in manifest["cases"]:
        for anchor in case["anchors"]:
            path = repo_root / anchor["file"]
            if not path.is_file():
                errors.append(f"{case['id']}: anchor file missing: {anchor['file']}")
                continue
            line = anchor_line(path.read_text(encoding="utf-8"), anchor)
            if line is None:
                errors.append(f"{case['id']}: anchor not found: {anchor}")
                continue
            expected.setdefault((anchor["file"], line), set()).add(case["id"])
    for (file, line), ids in sorted(expected.items()):
        found = marker_ids((repo_root / file).read_text(encoding="utf-8").splitlines(), line)
        if found != ids:
            errors.append(
                f"{file}:{line + 1}: marker '# {MARKER} {', '.join(sorted(ids))}' required, found {found}"
            )
    return errors + _stray_marker_errors(manifest, repo_root, expected)


def _comment_block_above(lines: list[str], index: int) -> set[int]:
    owned, cursor = set(), index - 1
    while cursor >= 0 and lines[cursor].strip().startswith("#"):
        owned.add(cursor)
        cursor -= 1
    return owned


def _stray_marker_errors(
    manifest: dict[str, Any], repo_root: Path, expected: dict[tuple[str, int], set[str]]
) -> list[str]:
    """A marker must sit directly above a manifest anchor; any other is stray."""
    files = {file for file, _ in expected} | {
        str(path.relative_to(repo_root))
        for path in (repo_root / "consent-protocol/hushh_mcp/agents").glob("*/agent.yaml")
    }
    errors = []
    for file in sorted(files):
        lines = (repo_root / file).read_text(encoding="utf-8").splitlines()
        owned = set().union(
            *(_comment_block_above(lines, line) for f, line in expected if f == file)
        )
        for i, line in enumerate(lines):
            if MARKER in line and i not in owned:
                errors.append(f"{file}:{i + 1}: marker does not belong to a manifest anchor")
    return errors


def repository_errors(manifest: dict[str, Any], repo_root: Path) -> list[str]:
    errors = list(validate_schema(manifest))
    config = json.loads((repo_root / manifest["provider_config"]).read_text(encoding="utf-8"))
    for case in manifest["cases"]:
        grader_path, symbol = case["grader"].rsplit(":", 1)
        for path in [grader_path, *case["code_paths"]]:
            if not (repo_root / path).is_file():
                errors.append(f"{case['id']}: missing file {path}")
        if (repo_root / grader_path).is_file() and symbol not in _module_symbols(
            (repo_root / grader_path).read_text(encoding="utf-8")
        ):
            errors.append(f"{case['id']}: grader symbol {symbol} not found")
        for ref in case["provider"].get("config_refs", []):
            try:
                resolve_config_ref(config, ref)
            except KeyError:
                errors.append(f"{case['id']}: unresolved config ref {ref}")
    return (
        errors + anchor_errors(manifest, repo_root) + coverage_errors(manifest, repo_root, config)
    )


def _text_scopes(repo_root: Path) -> set[str]:
    source = (repo_root / "consent-protocol/hushh_mcp/runtime_providers/managed_text.py").read_text(
        encoding="utf-8"
    )
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(
            getattr(t, "id", "") == "TEXT_SCOPES" for t in node.targets
        ):
            return {
                elt.value
                for elt in ast.walk(node.value)
                if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
            }
    return set()


def coverage_errors(manifest: dict[str, Any], repo_root: Path, config: dict[str, Any]) -> list[str]:
    ids = {case["id"] for case in manifest["cases"]}
    errors = []
    required = set(resolve_config_ref(config, "managed_runtime_uat.required_capabilities"))
    declared = {cid.removeprefix("capability.") for cid in ids if cid.startswith("capability.")}
    if declared != required:
        errors.append(
            f"capability cases {sorted(declared ^ required)} differ from required_capabilities"
        )
    scopes = {
        cid.removeprefix("managed_text.scope.")
        for cid in ids
        if cid.startswith("managed_text.scope.")
    }
    if scopes != _text_scopes(repo_root):
        errors.append(f"managed text scope cases {sorted(scopes)} differ from TEXT_SCOPES")
    sources = "".join(
        (repo_root / path).read_text(encoding="utf-8")
        for path in (
            manifest["entrypoint"],
            "consent-protocol/scripts/probe_azure_openai_readiness.py",
        )
    )
    for case in manifest["cases"]:
        if case["stage"] not in STRUCTURAL_STAGES and f'"{case["stage"]}"' not in sources:
            errors.append(f"{case['id']}: stage {case['stage']} is not emitted by the exam")
    return errors


def cases_for_paths(manifest: dict[str, Any], paths: list[str]) -> list[str]:
    """Case ids whose anchors or code paths include any of `paths`."""
    changed = set(paths)
    return [
        case["id"]
        for case in manifest["cases"]
        if changed & ({a["file"] for a in case["anchors"]} | set(case["code_paths"]))
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check", action="store_true", help="validate the manifest against the repository"
    )
    parser.add_argument(
        "--affected", nargs="*", default=None, help="print case ids affected by these paths"
    )
    args = parser.parse_args(argv)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if args.affected is not None:
        print(json.dumps(cases_for_paths(manifest, args.affected)))
        return 0
    errors = repository_errors(manifest, BACKEND_ROOT.parent)
    for error in errors:
        print(f"readiness exam manifest: {error}", file=sys.stderr)
    if not errors:
        print(f"Readiness exam manifest is current ({len(manifest['cases'])} cases).")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
