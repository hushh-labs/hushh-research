from __future__ import annotations

import json
import os
import select
import subprocess
import sys
from pathlib import Path

import pytest
from mcp.shared.version import LATEST_PROTOCOL_VERSION

EXPECTED_TOOLS = [
    "search_user_scopes",
    "prepare_campaign_context",
    "request_consent",
    "check_consent_status",
    "get_encrypted_scoped_export",
]


def _read_json_line(process: subprocess.Popen[str], timeout: float = 10.0) -> dict:
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready or process.stdout is None:
        stderr = process.stderr.read(2000) if process.stderr else ""
        raise AssertionError(f"MCP server did not respond: {stderr}")
    line = process.stdout.readline()
    assert line, process.stderr.read(2000) if process.stderr else ""
    return json.loads(line)


@pytest.mark.parametrize(
    "protocol_version",
    ["2024-11-05", "2025-06-18", LATEST_PROTOCOL_VERSION],
)
def test_live_stdio_negotiates_supported_versions_and_lists_exact_tools(
    protocol_version: str,
) -> None:
    root = Path(__file__).resolve().parents[1]
    env = {
        **os.environ,
        "TESTING": "true",
        "APP_SIGNING_KEY": "test_secret_key_for_pytest_only_32chars_min",
        "VAULT_DATA_KEY": "0" * 64,
        "PYTHONPATH": str(root),
    }
    env.pop("HUSHH_DEVELOPER_TOKEN", None)
    process = subprocess.Popen(  # noqa: S603 - fixed interpreter and repo-local server path
        [sys.executable, str(root / "mcp_server.py")],
        cwd=root,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdin is not None
    try:
        process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": protocol_version,
                        "capabilities": {},
                        "clientInfo": {"name": "contract-test", "version": "1.0"},
                    },
                }
            )
            + "\n"
        )
        process.stdin.flush()
        initialized = _read_json_line(process)
        assert initialized["result"]["protocolVersion"] == protocol_version
        assert initialized["result"]["serverInfo"]["version"] == "0.3.0"

        process.stdin.write(
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
        )
        process.stdin.write(
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}) + "\n"
        )
        process.stdin.flush()
        listed = _read_json_line(process)
        assert [tool["name"] for tool in listed["result"]["tools"]] == EXPECTED_TOOLS
        assert all(
            tool["inputSchema"]["additionalProperties"] is False
            for tool in listed["result"]["tools"]
        )
        assert all("outputSchema" in tool for tool in listed["result"]["tools"])

        process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "check_consent_status",
                        "arguments": {"request_ref": "req_" + "0" * 28},
                    },
                }
            )
            + "\n"
        )
        process.stdin.flush()
        failed_call = _read_json_line(process)
        assert failed_call["result"]["isError"] is True
        assert failed_call["result"]["structuredContent"]["error_code"] == "AUTHENTICATION_REQUIRED"
    finally:
        process.terminate()
        process.wait(timeout=5)
