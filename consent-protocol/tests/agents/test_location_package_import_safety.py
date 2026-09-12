"""Compatibility and import-safety proof for the Location agent package."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PROTOCOL_ROOT = Path(__file__).resolve().parents[2]


def _run_probe(source: str, *, environment: dict[str, str]) -> dict[str, object]:
    result = subprocess.run(  # noqa: S603 - fixed interpreter and repository-owned source
        [sys.executable, "-I", "-c", source],
        cwd=PROTOCOL_ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _environment_without_core_keys() -> dict[str, str]:
    environment = dict(os.environ)
    for name in ("APP_SIGNING_KEY", "VAULT_DATA_KEY", "BACKEND_RUNTIME_CONFIG_JSON"):
        environment.pop(name, None)
    return environment


def test_command_brain_import_needs_no_application_signing_or_vault_keys() -> None:
    result = _run_probe(
        f"""
import json
import sys
sys.path.insert(0, {str(PROTOCOL_ROOT)!r})
from hushh_mcp.agents.location.command_brain import LocationCommandBrain

print(json.dumps({{
    "brain": LocationCommandBrain.__name__,
    "legacy_agent_loaded": "hushh_mcp.agents.location.agent" in sys.modules,
    "core_security_config_loaded": "hushh_mcp.config" in sys.modules,
}}))
""",
        environment=_environment_without_core_keys(),
    )

    assert result == {
        "brain": "LocationCommandBrain",
        "legacy_agent_loaded": False,
        "core_security_config_loaded": False,
    }


def test_historical_location_agent_exports_remain_lazy_and_compatible() -> None:
    environment = _environment_without_core_keys()
    environment.update(
        {
            "APP_SIGNING_KEY": "test_secret_key_for_location_import_32chars",
            "VAULT_DATA_KEY": "0" * 64,
        }
    )
    result = _run_probe(
        f"""
import json
import sys
sys.path.insert(0, {str(PROTOCOL_ROOT)!r})
import hushh_mcp.agents.location as location

before = "hushh_mcp.agents.location.agent" in sys.modules
from hushh_mcp.agents.location import LocationAgent, get_location_chat_agent_v2
print(json.dumps({{
    "before": before,
    "agent_class": LocationAgent.__name__,
    "factory_callable": callable(get_location_chat_agent_v2),
    "agent_loaded": "hushh_mcp.agents.location.agent" in sys.modules,
}}))
""",
        environment=environment,
    )

    assert result == {
        "before": False,
        "agent_class": "LocationAgent",
        "factory_callable": True,
        "agent_loaded": True,
    }
