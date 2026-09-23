#!/usr/bin/env python3
"""Report local coding-agent tool readiness without reading secret values."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess

OPTIONAL_MCPS = (
    ("hushh_consent", "HUSHH_DEVELOPER_TOKEN"),
    ("hushh_founder_wiki", "HUSHH_FOUNDER_WIKI_MCP_TOKEN"),
    ("shadcn", ""),
    ("plaid", "PLAID_CLIENT_ID,PLAID_SECRET"),
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    codex = shutil.which("codex")
    listing, list_error = "", None
    if codex:
        completed = subprocess.run([codex, "mcp", "list"], capture_output=True, text=True, check=False)
        listing = f"{completed.stdout}\n{completed.stderr}".lower()
        if completed.returncode:
            list_error = completed.stderr.strip() or "codex mcp list failed"
    mcp = []
    for name, env_names in OPTIONAL_MCPS:
        required = [key for key in env_names.split(",") if key]
        mcp.append({"name": name, "configured": name in listing, "credential_environment": required, "credential_environment_present": {key: bool(os.environ.get(key)) for key in required}, "optional": True})
    report = {"codex_available": bool(codex), "mcp_list_error": list_error, "mcp": mcp}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"Codex executable: {'available' if codex else 'missing'}")
        if list_error:
            print(f"MCP listing: unavailable ({list_error})")
        for entry in mcp:
            print(f"- {entry['name']}: {'configured' if entry['configured'] else 'not configured'} (optional)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
