"""action_tools.py's direct calls into these two services must stay type-checked.

PR #5958 un-quarantined hushh_mcp.services.one_location_agent_service and
hushh_mcp.services.connections_service from mypy specifically because
hushh_mcp/one_adk/action_tools.py calls their methods directly (create_grant,
request_access, list_verified_recipients, search_directory, create_request,
and more), bypassing the @hushh_tool layer. Verified empirically at the time:
renaming create_grant's recipient_user_id parameter with the override in
place reproduced the exact call-arg error CI would catch; removing the
override made the same rename invisible to mypy again.

THE FAILURE MODE THIS GUARDS: removing the override does not make mypy
report an error -- it makes the existing protection silently disappear.
A test that just re-runs mypy and asserts zero errors cannot catch that,
because dropping the override is exactly what makes errors stop appearing.
If another PR's merge/rebase conflict resolution drops this override block
from pyproject.toml (it sits right next to the still-legitimately-quarantined
hushh_mcp.services.* wildcard, an easy line to lose), Protocol (Python) goes
green again with the drift-safety fix quietly gone and nobody told.

So this asserts the override's PRESENCE and shape directly, independent of
whether mypy currently reports any errors at all.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

PYPROJECT_PATH = Path(__file__).resolve().parents[1] / "pyproject.toml"

# The two services hushh_mcp/one_adk/action_tools.py calls directly. If a
# third service joins that pattern, it needs the same override -- this list
# is deliberately exact, not derived from action_tools.py's imports, so a
# new direct-call service is a conscious addition here, not an assumption.
DIRECTLY_CALLED_SERVICE_MODULES = {
    "hushh_mcp.services.one_location_agent_service",
    "hushh_mcp.services.connections_service",
}


def _mypy_overrides() -> list[dict]:
    config = tomllib.loads(PYPROJECT_PATH.read_text(encoding="utf-8"))
    overrides = config.get("tool", {}).get("mypy", {}).get("overrides")
    assert isinstance(overrides, list), (
        f"{PYPROJECT_PATH} has no [[tool.mypy.overrides]] at all -- "
        "the whole mypy override mechanism this test protects is gone."
    )
    return overrides


def test_the_two_directly_called_services_are_not_skip_imported() -> None:
    overrides = _mypy_overrides()

    followed: set[str] = set()
    for override in overrides:
        modules = override.get("module")
        if modules is None:
            continue
        module_names = {modules} if isinstance(modules, str) else set(modules)
        if override.get("follow_imports") != "skip":
            followed.update(module_names)

    missing = DIRECTLY_CALLED_SERVICE_MODULES - followed
    assert not missing, (
        f"{missing} no longer have a non-skip mypy override in {PYPROJECT_PATH}. "
        "action_tools.py calls these services' methods directly (create_grant, "
        "request_access, list_verified_recipients, search_directory, "
        "create_request, ...); without this override a renamed or retyped "
        "parameter on either service breaks action_tools.py silently, with "
        "no CI signal until it fails at runtime. See PR #5958."
    )


def test_the_override_is_not_shadowed_by_a_later_skip_override() -> None:
    """TOML overrides apply in file order; a later skip block for the same
    module would win even though the earlier one looks like it's still there."""
    overrides = _mypy_overrides()

    module_positions: dict[str, list[tuple[int, str | None]]] = {
        module_name: [] for module_name in DIRECTLY_CALLED_SERVICE_MODULES
    }
    for index, override in enumerate(overrides):
        modules = override.get("module")
        if modules is None:
            continue
        module_names = {modules} if isinstance(modules, str) else set(modules)
        for module_name in module_names & DIRECTLY_CALLED_SERVICE_MODULES:
            module_positions[module_name].append((index, override.get("follow_imports")))

    for module_name, entries in module_positions.items():
        assert entries, f"{module_name} has no override entries at all in {PYPROJECT_PATH}."
        last_index, last_follow_imports = entries[-1]
        assert last_follow_imports != "skip", (
            f"{module_name}'s LAST matching override (entry {last_index}) sets "
            f"follow_imports=skip, which wins over any earlier non-skip override "
            f"for the same module. mypy would treat this service as untyped Any "
            f"again despite an override that looks like it protects it. See PR #5958."
        )
