from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/ops/verify_connected_systems_gateway.py"
SPEC = importlib.util.spec_from_file_location("verify_connected_systems_gateway", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


def test_gateway_readiness_uses_only_the_no_record_handshake(monkeypatch) -> None:
    secret_values = {
        "OMNIGATEWAY_CLIENT_ID": "client-id-value",
        "OMNIGATEWAY_CLIENT_SECRET": "client-secret-value",
    }
    monkeypatch.setattr(
        gateway,
        "_read_secret_value",
        lambda _project, name: secret_values.get(name),
    )
    monkeypatch.setattr(
        gateway,
        "_gateway_contract",
        lambda: ("https://gateway.example/mcp", frozenset({"object-schema", "read-crm-record"})),
    )

    seen: dict[str, object] = {}

    async def list_tools(endpoint: str, **kwargs: object) -> frozenset[str]:
        seen["endpoint"] = endpoint
        seen.update(kwargs)
        return frozenset({"object-schema", "read-crm-record", "create-crm-record"})

    monkeypatch.setattr(gateway, "_list_tools", list_tools)

    report = gateway.run("project", timeout_seconds=7)

    assert report == {
        "status": "healthy",
        "probe": "mcp_initialize_and_tools_list",
        "expectedToolCount": 2,
    }
    assert seen == {
        "endpoint": "https://gateway.example/mcp",
        "client_id": "client-id-value",
        "client_secret": "client-secret-value",
        "timeout_seconds": 7,
    }
    assert "client-id-value" not in str(report)
    assert "client-secret-value" not in str(report)


def test_gateway_readiness_fails_closed_when_a_secret_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(
        gateway,
        "_read_secret_value",
        lambda _project, name: "client-id-value" if name == "OMNIGATEWAY_CLIENT_ID" else None,
    )

    report = gateway.run("project")

    assert report == {
        "status": "blocked",
        "classification": "omni_gateway_secret_unavailable",
        "missingSecrets": ["OMNIGATEWAY_CLIENT_SECRET"],
    }


def test_gateway_readiness_fails_closed_when_the_tool_contract_drifts(monkeypatch) -> None:
    monkeypatch.setattr(gateway, "_read_secret_value", lambda *_args: "credential")
    monkeypatch.setattr(
        gateway,
        "_gateway_contract",
        lambda: ("https://gateway.example/mcp", frozenset({"object-schema", "read-crm-record"})),
    )

    async def list_tools(*_args: object, **_kwargs: object) -> frozenset[str]:
        return frozenset({"object-schema"})

    monkeypatch.setattr(gateway, "_list_tools", list_tools)

    assert gateway.run("project") == {
        "status": "blocked",
        "classification": "omni_gateway_tool_contract_mismatch",
        "missingTools": ["read-crm-record"],
    }
