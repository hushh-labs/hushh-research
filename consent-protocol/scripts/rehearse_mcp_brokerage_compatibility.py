#!/usr/bin/env python3
"""Rehearse a synthetic multi-statement brokerage export for MCP consumers.

This is a local, no-network, no-database compatibility harness. It uses the
canonical demo brokerage fixture, the PKM manifest/scope projection, the real
X25519/AES-GCM envelope helpers, and the real connector decryptor. The final
projection is a fixed relational shape suitable for a connector-owned MCP
action: top-level statements and holdings arrays joined by statement_ref.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from mcp.types import TextContent  # noqa: E402

from hushh_mcp.consent.connector_projection import (  # noqa: E402
    FINANCIAL_STATEMENT_BUNDLE_SCHEMA,
    normalize_financial_statement_bundle,
)
from hushh_mcp.consent.export_envelope import (  # noqa: E402
    ConsentExportAadV2,
    connector_key_fingerprint,
)
from hushh_mcp.consent.export_projection import (  # noqa: E402
    decrypt_scoped_export_package,
    project_domain_data_for_scope,
)
from scripts.uat_kai_regression_smoke import (  # noqa: E402
    SAMPLE_BROKERAGE_PATH,
    UatKaiSmoke,
    _build_manifest_artifacts,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = REPO_ROOT / "tmp" / "mcp-brokerage-agentforce-rehearsal.json"
DEFAULT_DECRYPTED_OUTPUT = REPO_ROOT / "tmp" / "mcp-brokerage-decrypted-source.json"
DEFAULT_NORMALIZED_OUTPUT = REPO_ROOT / "tmp" / "mcp-brokerage-decrypted-normalized.json"
MACHINE_SCOPE = "attr.financial.documents.*"


def build_synthetic_financial_domain() -> dict[str, Any]:
    sample = json.loads(SAMPLE_BROKERAGE_PATH.read_text(encoding="utf-8"))
    statements = []
    periods = (
        ("stmt_demo_2026_05", "2026-05-01", "2026-05-31"),
        ("stmt_demo_2026_06", "2026-06-01", "2026-06-30"),
    )
    for statement_ref, period_start, period_end in periods:
        account_info = {
            **dict(sample.get("account_info") or {}),
            "statement_period_start": period_start,
            "statement_period_end": period_end,
        }
        statements.append(
            {
                "id": statement_ref,
                "account_info": account_info,
                "account_summary": dict(sample.get("account_summary") or {}),
                "holdings": list(sample.get("holdings") or []),
                "asset_allocation": dict(sample.get("asset_allocation") or {}),
            }
        )
    return {
        "schema_version": 3,
        "portfolio": sample,
        "documents": {
            "schema_version": 1,
            "statements": statements,
        },
    }


def run_rehearsal() -> dict[str, Any]:
    domain_data = build_synthetic_financial_domain()
    _, manifest = _build_manifest_artifacts(
        domain="financial",
        domain_data=domain_data,
        previous_manifest={"manifest_version": 4, "paths": []},
    )
    projected = project_domain_data_for_scope(
        "financial",
        MACHINE_SCOPE,
        domain_data,
        approved_paths=manifest.get("externalizable_paths") or [],
    )
    encrypted_source = {
        **projected,
        "__export_metadata": {
            "scope": MACHINE_SCOPE,
            "source_domain": "financial",
            "manifest_version": manifest.get("manifest_version"),
            "approved_paths": manifest.get("externalizable_paths") or [],
        },
    }

    smoke = UatKaiSmoke.__new__(UatKaiSmoke)
    connector = smoke._new_connector_keypair()
    aad = ConsentExportAadV2(
        app_id="app_synthetic_brokerage",
        grant_id="grant_synthetic_brokerage",
        export_id="123e4567-e89b-12d3-a456-426614174000",
        revision=1,
        machine_scope=MACHINE_SCOPE,
        scope_handle="s_synthetic_financial_documents",
        recipient_key_fingerprint=connector_key_fingerprint(connector.public_key_b64),
        expires_at_ms=1_900_000_000_000,
    )
    encrypted = smoke._encrypt_export_payload(
        encrypted_source,
        connector_public_key_b64=connector.public_key_b64,
        connector_key_id=connector.key_id,
        aad=aad,
    )
    decrypted = decrypt_scoped_export_package(
        wrapped_key_bundle={
            "wrapped_export_key": encrypted["wrappedExportKey"],
            "wrapped_key_iv": encrypted["wrappedKeyIv"],
            "wrapped_key_tag": encrypted["wrappedKeyTag"],
            "sender_public_key": encrypted["senderPublicKey"],
        },
        iv_b64=encrypted["encryptedIv"],
        tag_b64=encrypted["encryptedTag"],
        ciphertext=encrypted["encryptedData"],
        connector_private_key=connector.x25519_box,
        export_envelope=encrypted["exportEnvelope"],
    )
    decrypted.pop("__export_metadata", None)
    bundle = normalize_financial_statement_bundle(decrypted)

    text_mirror = json.dumps(bundle, separators=(",", ":"), ensure_ascii=False)
    mcp_result = {
        "content": [TextContent(type="text", text=text_mirror).model_dump(mode="json")],
        "structuredContent": bundle,
    }
    return {
        "classification": "synthetic_no_network_no_database_write",
        "current_hussh_mcp_request": {
            "name": "get-encrypted-scoped-export",
            "arguments": {
                "grant_ref": "grant_synthetic_brokerage",
                "expected_scope": MACHINE_SCOPE,
            },
        },
        "current_hosted_hussh_result": {
            "delivery": "encrypted_inline",
            "envelope_version": encrypted["version"],
            "machine_scope": MACHINE_SCOPE,
            "ciphertext": "<redacted: connector receives and decrypts this>",
        },
        "connector_decrypted_source": decrypted,
        "proposed_agentforce_action_output_schema": FINANCIAL_STATEMENT_BUNDLE_SCHEMA,
        "proposed_agentforce_action_mcp_result": mcp_result,
        "measurements": {
            "decrypted_source_json_bytes": len(
                json.dumps(decrypted, separators=(",", ":")).encode("utf-8")
            ),
            "normalized_bundle_json_bytes": len(text_mirror.encode("utf-8")),
            "statement_count": bundle["statement_count"],
            "holding_count": bundle["holding_count"],
        },
        "boundary": (
            "Hussh tool 5 remains encrypted for hosted MCP. The static statements/holdings "
            "result is emitted only by the trusted connector after envelope validation and decryption."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--decrypted-output", type=Path, default=DEFAULT_DECRYPTED_OUTPUT)
    parser.add_argument("--normalized-output", type=Path, default=DEFAULT_NORMALIZED_OUTPUT)
    args = parser.parse_args()
    result = run_rehearsal()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    args.decrypted_output.parent.mkdir(parents=True, exist_ok=True)
    args.decrypted_output.write_text(
        json.dumps(result["connector_decrypted_source"], indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    args.normalized_output.parent.mkdir(parents=True, exist_ok=True)
    args.normalized_output.write_text(
        json.dumps(
            result["proposed_agentforce_action_mcp_result"]["structuredContent"],
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "decrypted_output": str(args.decrypted_output),
                "normalized_output": str(args.normalized_output),
                **result["measurements"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
