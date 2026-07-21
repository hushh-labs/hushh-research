from pathlib import Path
from unittest.mock import MagicMock

import yaml

from hushh_mcp.services.connections_chat_service import ConnectionsChatService

_MANIFEST = (
    Path(__file__).resolve().parents[2] / "hushh_mcp" / "agents" / "connections" / "agent.yaml"
)


def test_manifest_tools_match_service_dispatch():
    manifest = yaml.safe_load(_MANIFEST.read_text())
    runtime_tools = set(ConnectionsChatService(service=MagicMock())._build_tools("u").keys())
    assert "tools" not in manifest
    assert runtime_tools


def test_manifest_identity():
    manifest = yaml.safe_load(_MANIFEST.read_text())
    assert manifest["id"] == "agent_connections"
    assert "agent.one.orchestrate" in manifest["required_scopes"]
