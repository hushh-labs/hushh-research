"""
tests/test_location_nav_tools.py

Unit tests for the Location navigate-only MCP tool handlers.
Verifies:
  - All handlers return list[TextContent] with valid JSON payload
  - action_id matches the canonical action manifest
  - completion_mode is route_settle for every navigate-only handler
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

# Import location_tools directly as a standalone module to avoid the
# asyncpg / DB-stack chain pulled in by mcp_modules/tools/__init__.py --
# mirrors tests/test_kai_voice_tools.py's approach for the same reason.
# Unlike kai_tools.py, location_tools.py also defines DB-backed read
# handlers, so this standalone import only exercises the nav helpers below;
# the read handlers are covered separately in test_location_read_tools.py.
_spec = importlib.util.spec_from_file_location(
    "location_tools_standalone",
    Path(__file__).parent.parent / "mcp_modules" / "tools" / "location_tools.py",
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["location_tools_standalone"] = _mod
_spec.loader.exec_module(_mod)

handle_location_open_now = _mod.handle_location_open_now
handle_location_open_people = _mod.handle_location_open_people
handle_location_open_links = _mod.handle_location_open_links
handle_location_open_share = _mod.handle_location_open_share
handle_location_open_ask = _mod.handle_location_open_ask
handle_location_open_map = _mod.handle_location_open_map
handle_location_open_settings = _mod.handle_location_open_settings
handle_location_open_sos = _mod.handle_location_open_sos
get_manifest_action_ids = _mod.get_manifest_action_ids


def _parse(result) -> dict:
    """Parse the first TextContent item as JSON."""
    assert result, "Handler returned empty list"
    text = result[0].text
    return json.loads(text)


NAV_CASES = [
    (handle_location_open_now, "location.open_now"),
    (handle_location_open_people, "location.open_people"),
    (handle_location_open_links, "location.open_links"),
    (handle_location_open_share, "location.open_share"),
    (handle_location_open_ask, "location.open_ask"),
    (handle_location_open_map, "location.open_map"),
    (handle_location_open_settings, "location.open_settings"),
    (handle_location_open_sos, "location.open_sos"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("handler,expected_action_id", NAV_CASES)
async def test_nav_tool(handler, expected_action_id):
    payload = _parse(await handler({}))
    assert payload["status"] == "success", f"Expected success, got: {payload}"
    assert payload["action_id"] == expected_action_id
    assert payload["completion_mode"] == "route_settle"
    assert "message" in payload
    assert len(payload["message"]) > 0


@pytest.mark.asyncio
@pytest.mark.parametrize("handler,expected_action_id", NAV_CASES)
async def test_action_id_is_registered_in_generated_manifest(handler, expected_action_id):
    payload = _parse(await handler({}))
    assert payload["status"] == "success"
    assert payload["action_id"] in get_manifest_action_ids()


@pytest.mark.asyncio
@pytest.mark.parametrize("handler,expected_action_id", NAV_CASES)
async def test_nav_tool_ignores_arguments(handler, expected_action_id):
    """Navigate-only handlers take no meaningful input; extra args are ignored."""
    payload = _parse(await handler({"unexpected": "value"}))
    assert payload["status"] == "success"
    assert payload["action_id"] == expected_action_id
