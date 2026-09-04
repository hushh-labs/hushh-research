#!/usr/bin/env python3
"""Fail closed if the retired Agent Chat protocol re-enters runtime code."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOTS = (
    ROOT / "consent-protocol/api",
    ROOT / "hushh-webapp/app",
    ROOT / "hushh-webapp/components",
    ROOT / "hushh-webapp/lib",
)
FORBIDDEN_RUNTIME = (
    "/api/kai/agent/chat",
    "/api/kai/agent-chat",
    "/api/kai/agent-intro",
    "/api/one/agent-chat/stream",
    "/api/one/agent-chat/actions",
)
FORBIDDEN_AGENT_CLIENT = (
    'event === "token"',
    'event === "tool_waiting"',
    'event === "specialist_directive"',
    "parseSSEBlocks",
    'title="Agent response stream"',
    'thinkingTitle="Working notes"',
)


def main() -> int:
    failures: list[str] = []
    retired = ROOT / "consent-protocol/api/routes/kai/agent_chat.py"
    if retired.exists():
        failures.append(f"retired route exists: {retired.relative_to(ROOT)}")
    for root in RUNTIME_ROOTS:
        for path in root.rglob("*"):
            if path.suffix not in {".py", ".ts", ".tsx"}:
                continue
            text = path.read_text(errors="replace")
            for marker in FORBIDDEN_RUNTIME:
                if marker in text:
                    failures.append(f"{path.relative_to(ROOT)} contains {marker!r}")

    pyproject = (ROOT / "consent-protocol/pyproject.toml").read_text()
    package = (ROOT / "hushh-webapp/package.json").read_text()
    route = (ROOT / "consent-protocol/api/routes/one/agent_chat.py").read_text()
    client = (ROOT / "hushh-webapp/lib/services/agent-chat-client.ts").read_text()
    for marker in FORBIDDEN_AGENT_CLIENT:
        if marker in client:
            failures.append(f"Agent Chat client contains retired parser marker {marker!r}")
    required = {
        "ag-ui-adk==0.7.0": pyproject,
        "ag-ui-protocol==0.1.21": pyproject,
        '"@ag-ui/core": "0.0.59"': package,
        '"@ag-ui/client": "0.0.59"': package,
        "ADKAgent.from_app": route,
        "ResumabilityConfig(is_resumable=True)": route,
        'path="/api/one/agent-chat"': route,
        "EncryptedAdkSessionService": route,
        "new HttpAgent": client,
    }
    for marker, text in required.items():
        if marker not in text:
            failures.append(f"missing required AG-UI contract marker: {marker}")
    if failures:
        print("AG-UI Agent Chat contract: FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("AG-UI Agent Chat contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
