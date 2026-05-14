# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""
scripts/export_schemas.py — Beast Mode Architecture by Abdul Gaffar

Exports Pydantic schemas from consent-protocol/ to TypeScript interfaces
for hushh-webapp/, eliminating manual type re-definition across the stack.

Usage (from repo root, inside the consent-protocol uv environment):
    cd consent-protocol && uv run python ../scripts/export_schemas.py

The generated file is committed to version control. CI enforces that the
committed file stays in sync with the source schema via schema-sync-check.sh.
"""
from __future__ import annotations

import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Path resolution — works from any cwd
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
CONSENT_PROTOCOL_DIR = REPO_ROOT / "consent-protocol"
OUTPUT_PATH = (
    REPO_ROOT
    / "hushh-webapp"
    / "lib"
    / "consent"
    / "consent-approval-payload.generated.ts"
)

if str(CONSENT_PROTOCOL_DIR) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_DIR))

from schemas import ConsentApprovalPayload  # noqa: E402  (path set above)

# ---------------------------------------------------------------------------
# JSON Schema → TypeScript type converter
# ---------------------------------------------------------------------------
_TS_PRIMITIVES: dict[str, str] = {
    "string": "string",
    "integer": "number",
    "number": "number",
    "boolean": "boolean",
    "null": "null",
}


def _resolve_ref(ref: str, defs: dict) -> dict:
    return defs.get(ref.split("/")[-1], {})


def _ts_type(node: dict, defs: dict) -> str:
    if "$ref" in node:
        return _ts_type(_resolve_ref(node["$ref"], defs), defs)

    if "anyOf" in node:
        parts = [_ts_type(n, defs) for n in node["anyOf"]]
        return " | ".join(dict.fromkeys(parts))  # deduplicate, preserve order

    t = node.get("type")

    if t == "array":
        return f"{_ts_type(node.get('items', {}), defs)}[]"

    if t == "object":
        return "Record<string, unknown>"

    if isinstance(t, list):
        return " | ".join(_TS_PRIMITIVES.get(x, "unknown") for x in t)

    return _TS_PRIMITIVES.get(str(t), "unknown")


def _interface_body(schema: dict) -> str:
    defs = schema.get("$defs", {})
    props: dict = schema.get("properties", {})
    required: set[str] = set(schema.get("required", []))

    lines: list[str] = []
    for name, prop in props.items():
        desc = prop.get("description", "").strip()
        ts = _ts_type(prop, defs)
        opt = "" if name in required else "?"
        if desc:
            lines.append(f"  /** {desc} */")
        lines.append(f"  {name}{opt}: {ts};")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# File template
# ---------------------------------------------------------------------------
_HEADER = """\
// AUTO-GENERATED — Beast Mode Architecture by Abdul Gaffar
// Source:  consent-protocol/schemas.py
// Script:  scripts/export_schemas.py
// Sync CI: scripts/ci/schema-sync-check.sh
//
// DO NOT EDIT MANUALLY.
// Re-generate with:  cd consent-protocol && uv run python ../scripts/export_schemas.py
//
// This file bridges the Python FastAPI backend (Pydantic v2) and the Next.js
// frontend (TypeScript), eliminating manual interface re-definition and
// ensuring 100% type parity across the consent approval flow.

"""

_FOOTER = """

// ---------------------------------------------------------------------------
// Convenience aliases — wire-format matches FastAPI camelCase JSON output
// ---------------------------------------------------------------------------

/** Minimum fields required in every approval request body. */
export type ConsentApprovalRequired = Pick<
  ConsentApprovalPayload,
  "userId" | "requestId"
>;

/** Full approval request body (required core + optional ZK-encrypted fields). */
export type ConsentApprovalBody = ConsentApprovalPayload;
"""


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    print("Beast Mode Architecture by Abdul Gaffar — Schema Export")
    print(f"  Source : {CONSENT_PROTOCOL_DIR / 'schemas.py'}")
    print(f"  Output : {OUTPUT_PATH}")

    schema = ConsentApprovalPayload.model_json_schema(by_alias=True)
    body = _interface_body(schema)
    content = f"{_HEADER}export interface ConsentApprovalPayload {{\n{body}\n}}{_FOOTER}"

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(content, encoding="utf-8", newline="\n")

    print(f"  OK: {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    print("Done.")


if __name__ == "__main__":
    main()
