"""Read-only release receipts cannot be replaced by a parked migration tail."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from db.migration_authority import (
    MigrationAuthorityError,
    build_manifest_entries,
    manifest_checksum,
)
from db.migration_readiness import verified_manifest_head


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation", [None, "covered", "missing", "failed", "checksum", "baseline", "parked_only"]
)
async def test_read_only_manifest_head_requires_release_receipts_despite_parked_tail(
    tmp_path: Path, mutation: str | None
):
    for version in (289, 290):
        (tmp_path / f"{version}_release.sql").write_text(f"SELECT {version}")
    entries = build_manifest_entries(tmp_path, ("289_release.sql", "290_release.sql"))
    conn = SimpleNamespace(fetch=AsyncMock())
    conn.rows = {
        e.migration_id: {
            "migration_id": e.migration_id,
            "filename": e.filename,
            "checksum_sha256": e.checksum_sha256,
            "status": "applied",
            "baseline_through": None,
        }
        for e in entries
    }
    conn.rows["957"] = {"migration_id": "957", "status": "applied", "baseline_through": None}
    if mutation == "missing":
        del conn.rows["289"]
    elif mutation == "failed":
        conn.rows["290"]["status"] = "failed"
    elif mutation == "checksum":
        conn.rows["290"]["checksum_sha256"] = "0" * 64
    elif mutation in {"covered", "baseline"}:
        del conn.rows["289"]
        conn.rows["baseline:289"] = {
            "migration_id": "baseline:289",
            "status": "baseline",
            "baseline_through": 289,
            "checksum_sha256": manifest_checksum(entries[:1])
            if mutation == "covered"
            else "0" * 64,
        }
    elif mutation == "parked_only":
        conn.rows = {"957": conn.rows["957"]}
    conn.fetch.return_value = list(conn.rows.values())

    async def verify():
        return await verified_manifest_head(conn, entries)

    if mutation in {"checksum", "baseline"}:
        with pytest.raises(MigrationAuthorityError, match="checksum changed"):
            await verify()
    else:
        expected = 290 if mutation in {None, "covered"} else None
        assert await verify() == expected
    conn.fetch.assert_awaited_once()
