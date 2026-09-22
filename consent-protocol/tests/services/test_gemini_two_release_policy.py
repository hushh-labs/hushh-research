"""Founder rule 2026-09-14: the fleet supports exactly the last two Gemini releases.

A roll-forward replaces the oldest id, it never adds a third. This test holds every
surface that names a text release to that rule: the generation contract, the person
facing catalog, the lane default, the code tree, the deploy substitutions, and the
agent manifests. It reads files only; nothing here touches a network.
"""

from __future__ import annotations

import pathlib
import re

import yaml

from hushh_mcp.constants import FLEET_TEXT_MODEL_DEFAULT
from hushh_mcp.runtime_providers import gemini_config, model_catalog

BACKEND_ROOT = pathlib.Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent
SUPPORTED = gemini_config.SUPPORTED_GEMINI_TEXT_MODELS

_RELEASE_ID = re.compile(r"^gemini-3\.(\d+)-flash$")

# Any gemini-3.<n>-<family> id on a code line under the scanned roots. Comment lines are
# skipped so a docstring or comment may still explain why a release was retired.
_ANY_GEMINI_3_ID = re.compile(r"gemini-3\.\d+-[a-z0-9.-]+")
_SCANNED_ROOTS = ("hushh_mcp", "api", "scripts")
_SCANNED_SUFFIXES = {".py", ".yaml", ".yml", ".json", ".toml", ".sh", ".txt"}

# Ids that may appear on a code line even though they are not one of the two supported
# text releases. Every entry needs a reason; an empty tuple is the expected steady state.
# gemini-embedding-001 needs no entry: it is not a gemini-3.<n>- id and is retrieval, not
# generation.
_ALLOWED_OTHER_IDS: tuple[tuple[str, str], ...] = ()

# Deploy substitutions that pin a lane's text model. Both spellings are matched: the
# Cloud Build substitution (_HUSSH_GEMINI_TEXT_MODEL) and the runtime env name it feeds.
_SUBSTITUTION_VALUE = re.compile(r"_?HUSSH_GEMINI_TEXT_MODEL=([^#,\"'\s|\\]*)")
_SUBSTITUTION_DEFAULT = re.compile(r"_HUSSH_GEMINI_TEXT_MODEL:\s*\"?([^\"\n]*)\"?")

_MANIFEST_ALIASES = {"gemini-default"}


def _minor(model_id: str) -> int:
    match = _RELEASE_ID.fullmatch(model_id)
    assert match, f"{model_id!r} is not a gemini-3.<n>-flash release id"
    return int(match.group(1))


def test_contract_names_exactly_two_consecutive_releases_newest_first() -> None:
    assert len(SUPPORTED) == 2, SUPPORTED
    assert len(set(SUPPORTED)) == 2, SUPPORTED
    newest, previous = (_minor(model_id) for model_id in SUPPORTED)
    assert newest == previous + 1, f"expected consecutive minors newest first, got {SUPPORTED}"


def test_catalog_offers_exactly_the_supported_releases() -> None:
    assert model_catalog.FLEET_TEXT_MODEL_CHOICES == SUPPORTED
    for model_id in SUPPORTED:
        assert model_catalog.is_selectable_text_model(model_id), model_id


def test_lane_default_is_a_supported_release() -> None:
    assert FLEET_TEXT_MODEL_DEFAULT in SUPPORTED


def _code_lines(path: pathlib.Path) -> list[tuple[int, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []
    return [
        (number, line)
        for number, line in enumerate(text.splitlines(), 1)
        if not line.lstrip().startswith("#")
    ]


def test_no_other_gemini_3_text_id_on_a_code_line() -> None:
    allowed = {model_id for model_id, _reason in _ALLOWED_OTHER_IDS}
    offenders: list[str] = []
    for root_name in _SCANNED_ROOTS:
        root = BACKEND_ROOT / root_name
        assert root.is_dir(), root
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix not in _SCANNED_SUFFIXES:
                continue
            for number, line in _code_lines(path):
                for model_id in _ANY_GEMINI_3_ID.findall(line):
                    # Native realtime candidates are governed by the Live
                    # registry, not the two-release text fleet policy.
                    if "-live-" in model_id or model_id.endswith("-live"):
                        continue
                    if model_id in SUPPORTED or model_id in allowed:
                        continue
                    offenders.append(f"{path.relative_to(BACKEND_ROOT)}:{number}: {model_id}")
    assert offenders == [], "\n".join(
        ["only the two supported releases may be named on a code line:", *offenders]
    )


def test_every_allowed_exception_is_still_used() -> None:
    # An exception that no longer matches anything is stale and must be removed, so the
    # list cannot quietly grow into a third release.
    for model_id, reason in _ALLOWED_OTHER_IDS:
        assert reason.strip(), model_id
        found = any(
            model_id in line
            for root_name in _SCANNED_ROOTS
            for path in (BACKEND_ROOT / root_name).rglob("*")
            if path.is_file() and path.suffix in _SCANNED_SUFFIXES
            for _number, line in _code_lines(path)
        )
        assert found, f"allowed exception {model_id!r} matches nothing; remove it"


def _deploy_files() -> list[pathlib.Path]:
    deploy_dir = REPO_ROOT / "deploy"
    workflows_dir = REPO_ROOT / ".github" / "workflows"
    assert deploy_dir.is_dir(), deploy_dir
    assert workflows_dir.is_dir(), workflows_dir
    return sorted(
        [
            *deploy_dir.rglob("*.yaml"),
            *deploy_dir.rglob("*.yml"),
            *workflows_dir.glob("*.yml"),
            *workflows_dir.glob("*.yaml"),
        ]
    )


def test_deploy_substitutions_pin_only_supported_releases() -> None:
    pinned: dict[str, str] = {}
    offenders: list[str] = []
    for path in _deploy_files():
        text = path.read_text(encoding="utf-8")
        for pattern in (_SUBSTITUTION_VALUE, _SUBSTITUTION_DEFAULT):
            for match in pattern.finditer(text):
                value = match.group(1).strip()
                if not value or value.startswith("${"):
                    continue
                pinned[str(path.relative_to(REPO_ROOT))] = value
                if value not in SUPPORTED:
                    offenders.append(f"{path.relative_to(REPO_ROOT)}: {value}")
    assert offenders == [], f"deploy lanes may pin only {SUPPORTED}: {offenders}"
    # The lanes do pin a literal (dev, uat, production); a scan that found none would
    # prove nothing.
    assert pinned, "no deploy lane pins HUSSH_GEMINI_TEXT_MODEL; the scan is broken"


def _declared_models(node: object) -> list[str]:
    """Every ``model`` declaration in a manifest tree, top level and subagent blocks."""
    found: list[str] = []
    if isinstance(node, dict):
        model = node.get("model")
        if isinstance(model, str):
            found.append(model)
        elif isinstance(model, dict) and isinstance(model.get("name"), str):
            found.append(model["name"])
        for value in node.values():
            if isinstance(value, dict | list):
                found.extend(_declared_models(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(_declared_models(item))
    return found


def test_every_agent_manifest_declares_the_alias_or_a_supported_release() -> None:
    manifests = sorted((BACKEND_ROOT / "hushh_mcp" / "agents").glob("*/agent.yaml"))
    assert manifests, "no agent manifests found"
    offenders: list[str] = []
    for path in manifests:
        manifest = yaml.safe_load(path.read_text(encoding="utf-8"))
        declared = _declared_models(manifest)
        if not declared:
            offenders.append(f"{path.parent.name}: no model declared")
            continue
        for model_id in declared:
            if model_id in _MANIFEST_ALIASES or model_id in SUPPORTED:
                continue
            offenders.append(f"{path.parent.name}: {model_id}")
    assert offenders == [], (
        f"manifests must declare gemini-default or one of {SUPPORTED}: {offenders}"
    )
