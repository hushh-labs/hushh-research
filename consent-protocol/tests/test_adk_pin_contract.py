"""Pin contract for the google-adk runtime One is built on.

Every assertion here was measured against google-adk 2.9.0 when the pin moved
from 2.4.0. The point is not that these behaviours are desirable; it is that a
future bump that silently changes one of them is noticed at the pin, not in a
person's pod at request time.
"""

from __future__ import annotations

import ast
import asyncio
import re
import tomllib
from importlib.metadata import version
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = ROOT / "pyproject.toml"
FIRST_PARTY_ROOTS = ("hushh_mcp", "api", "scripts")

_PIN_PATTERN = re.compile(r"^google-adk(?:\[[^\]]*\])?==(?P<version>[0-9][0-9A-Za-z.]*)$")


def _pinned_google_adk_from_pyproject() -> str:
    dependencies = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]["dependencies"]
    pins = [
        match.group("version")
        for requirement in dependencies
        if (match := _PIN_PATTERN.match(requirement.strip())) is not None
    ]
    assert len(pins) == 1, f"expected exactly one exact google-adk pin in pyproject, found {pins}"
    return pins[0]


def _first_party_python_files() -> list[Path]:
    files: list[Path] = []
    for root_name in FIRST_PARTY_ROOTS:
        root = ROOT / root_name
        if not root.is_dir():
            continue
        files.extend(path for path in root.rglob("*.py") if "__pycache__" not in path.parts)
    return files


def _imports_google_adk_workflow(path: Path) -> bool:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name.startswith("google.adk.workflow") for alias in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module.startswith("google.adk.workflow"):
                return True
            if module == "google.adk" and any(alias.name == "workflow" for alias in node.names):
                return True
    return False


def test_installed_google_adk_matches_the_pyproject_pin() -> None:
    pinned = _pinned_google_adk_from_pyproject()
    installed = version("google-adk")
    assert installed == pinned, f"pyproject pins google-adk=={pinned} but {installed} is installed"


def test_runtime_readiness_guard_matches_the_pyproject_pin() -> None:
    from hushh_mcp import runtime_readiness

    pinned = _pinned_google_adk_from_pyproject()
    assert runtime_readiness.PINNED_GOOGLE_ADK_VERSION == pinned, (
        "hushh_mcp/runtime_readiness.py must move with pyproject; server.py refuses "
        "to boot when the two disagree"
    )
    assert runtime_readiness.assert_pinned_google_adk() == pinned


def test_compliance_verifier_matches_the_pyproject_pin() -> None:
    source = (ROOT / "scripts" / "verify_adk_a2a_compliance.py").read_text(encoding="utf-8")
    match = re.search(r'^PINNED_ADK_VERSION = "(?P<version>[^"]+)"$', source, re.MULTILINE)
    assert match is not None, "scripts/verify_adk_a2a_compliance.py must declare PINNED_ADK_VERSION"
    assert match.group("version") == _pinned_google_adk_from_pyproject()


def test_no_first_party_module_imports_google_adk_workflow() -> None:
    files = _first_party_python_files()
    assert files, "expected first-party python files under hushh_mcp/, api/, scripts/"
    offenders = [
        str(path.relative_to(ROOT)) for path in files if _imports_google_adk_workflow(path)
    ]
    assert offenders == [], (
        "google.adk.workflow is not part of One's runtime contract (2.9.0 changed "
        f"failed-node rerun semantics); importers: {offenders}"
    )


def test_in_memory_session_service_returns_none_for_an_unknown_session() -> None:
    # Measured on google-adk 2.9.0: the service returns None; it is the Runner
    # (google.adk.runners) that raises SessionNotFoundError on a missing
    # session. If a bump makes the service raise instead, this is the place
    # that notices before a pod does.
    from google.adk.errors.session_not_found_error import SessionNotFoundError
    from google.adk.sessions import InMemorySessionService

    assert issubclass(SessionNotFoundError, Exception)

    service = InMemorySessionService()
    result = asyncio.run(
        service.get_session(app_name="adk-pin-contract", user_id="nobody", session_id="unknown")
    )
    assert result is None


def test_remote_a2a_agent_imports_against_the_pinned_pair() -> None:
    # 2.4.0 failed this import against a2a-sdk 1.x because it reached for
    # a2a.client.ClientEvent. 2.9.0 routes through google.adk.a2a._compat.
    a2a = pytest.importorskip("a2a", reason="google-adk[a2a] extra not installed")
    assert a2a is not None
    from google.adk.agents.remote_a2a_agent import RemoteA2aAgent

    assert RemoteA2aAgent is not None
    assert version("a2a-sdk") == "0.3.26", (
        "the locked a2a-sdk moved; re-run the RemoteA2aAgent import and the "
        "official transport tests before trusting the new pair"
    )
