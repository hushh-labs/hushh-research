# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Contract and negative-control tests for #9429 ChatGPT/Claude archive import into `one_wiki`."""

from __future__ import annotations

import io
import json
import stat
import zipfile

import pytest

from hushh_eval.wiki_memory.conformance import (
    _InMemoryCasStore,
    evaluate_external_ai_archive_import,
)
from hushh_mcp.services.wiki_memory import (
    WikiArchiveImporter,
    WikiLibrary,
    WikiOwnerMigrator,
    WikiProjectionEngine,
    WikiRefused,
    extract_archive_json_documents,
)


@pytest.mark.asyncio
async def test_external_ai_archive_import_conformance_suite() -> None:
    report = await evaluate_external_ai_archive_import()
    assert report["all_passed"] is True
    assert all(report["checks"].values())


def test_archive_guard_rejects_zip_slip_symlink_and_compression_bomb() -> None:
    # 1. Path traversal (`..`) refused
    traversal_buf = io.BytesIO()
    with zipfile.ZipFile(traversal_buf, "w") as zf:
        zf.writestr("sub/../../passwd.json", "{}")
    with pytest.raises(WikiRefused) as exc_info:
        extract_archive_json_documents(traversal_buf.getvalue())
    assert exc_info.value.code == "WIKI_ARCHIVE_UNSAFE"

    # 2. Symlink mode bit refused
    symlink_buf = io.BytesIO()
    with zipfile.ZipFile(symlink_buf, "w") as zf:
        info = zipfile.ZipInfo("conversations.json")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, "/etc/passwd")
    with pytest.raises(WikiRefused) as exc_info:
        extract_archive_json_documents(symlink_buf.getvalue())
    assert exc_info.value.code == "WIKI_ARCHIVE_UNSAFE"

    # 3. High-ratio compression bomb (> 64 KiB and > 40x ratio) refused before full allocation
    bomb_buf = io.BytesIO()
    with zipfile.ZipFile(bomb_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("conversations.json", "A" * (512 * 1024))
    with pytest.raises(WikiRefused) as exc_info:
        extract_archive_json_documents(bomb_buf.getvalue())
    assert exc_info.value.code == "WIKI_ARCHIVE_UNSAFE"

    # 4. Nested `.zip` archive refused
    nested_buf = io.BytesIO()
    with zipfile.ZipFile(nested_buf, "w") as zf:
        zf.writestr("inner.zip", b"PK\x03\x04")
    with pytest.raises(WikiRefused) as exc_info:
        extract_archive_json_documents(nested_buf.getvalue())
    assert exc_info.value.code == "WIKI_ARCHIVE_UNSAFE"


@pytest.mark.asyncio
async def test_archive_import_scrubs_secrets_blocks_forbidden_domains_and_confirms_candidates() -> (
    None
):
    async def _ok() -> None:
        return None

    store = _InMemoryCasStore(
        expected_custody_ref="kms/test-archive-9429",
        supports_physical_delete=True,
    )
    lib = WikiLibrary(
        owner="usr_test_9429",
        key=bytes([0x33]) * 32,
        store=store,
        check=_ok,
        account_generation=1,
        library_id="lib_test_9429",
    )
    importer = WikiArchiveImporter(lib)
    projections = WikiProjectionEngine(lib)
    migrator = WikiOwnerMigrator(lib)

    payload = json.dumps(
        {
            "memories": [
                {"content": "Prefers window seats on red-eye flights to Tokyo."},
            ],
            "conversations": [
                {
                    "conversation_id": "conv_sec_1",
                    "title": "API Key Test",
                    "mapping": {
                        "u1": {
                            "message": {
                                "author": {"role": "user"},
                                "create_time": 1763000100,
                                "content": {
                                    "content_type": "text",
                                    "parts": [
                                        "My test credential api_key: fake0000fake and I love matcha."
                                    ],
                                },
                            }
                        }
                    },
                }
            ],
        }
    ).encode("utf-8")

    # Forbidden projection domain (`financial` / `identity`) must fail closed
    with pytest.raises(WikiRefused) as forbidden_exc:
        await importer.import_archive_bytes(
            file_id="c" * 32,
            file_name="export.json",
            raw_bytes=payload,
            idempotency_key="aaaa-bbbb",
            explicit_candidate_mappings=[
                {
                    "statement": "Prefers window seats on red-eye flights to Tokyo.",
                    "domain": "financial",
                    "json_path": "accounts.primary",
                }
            ],
        )
    assert forbidden_exc.value.code == "WIKI_PROJECTION_DOMAIN_FORBIDDEN"

    # Valid import scrubs secret span and holds candidate in `private_candidate`
    res = await importer.import_archive_bytes(
        file_id="c" * 32,
        file_name="export.json",
        raw_bytes=payload,
        idempotency_key="cccc-dddd",
    )
    assert res["untrusted_data"] is True
    assert res["instruction_authority"] == "none"
    assert len(res["candidate_receipt_ids"]) == 1

    for pid in res["page_ids"]:
        page = await lib.read_page(pid)
        assert "fake0000fake" not in page["body"]

    receipt_id = res["candidate_receipt_ids"][0]
    before_confirm = await lib.get_projection_receipt(receipt_id)
    assert before_confirm["state"] == "private_candidate"
    assert before_confirm["exposure_eligibility"] is False

    after_confirm = await projections.confirm_candidate_projection(
        receipt_id, idempotency_key="eeee-ffff"
    )
    assert after_confirm["state"] == "materialized"
    assert after_confirm["exposure_eligibility"] is True

    # Forgetting the claim transitions the confirmed receipt to stale (exposure_eligibility=False)
    await migrator.propagate_forget_and_correction(
        page_id=after_confirm["page_id"],
        claim_id=after_confirm["claim_id"],
        idempotency_key="gggg-hhhh",
        destroy_page_key=True,
    )
    after_forget = await lib.get_projection_receipt(receipt_id)
    assert after_forget["state"] == "stale"
    assert after_forget["exposure_eligibility"] is False
