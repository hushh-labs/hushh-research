"""Read-only manifest readiness using the canonical migration checksum authority."""

from typing import Any

from db.migration_authority import (
    MigrationManifestEntryV2,
    _assert_baseline_manifest,
    _assert_checksum,
    _baseline_through,
    _ledger_rows,
)


async def verified_manifest_head(
    conn: Any, entries: tuple[MigrationManifestEntryV2, ...]
) -> int | None:
    """Project a complete checksummed lane without DDL, locks or ledger writes.

    Other lanes may contain higher versions. They cannot establish this lane's
    readiness. A verified baseline covers only its exact manifest prefix.
    """
    if not entries:
        return None
    rows = await _ledger_rows(conn)
    baseline = _baseline_through(rows)
    _assert_baseline_manifest(entries, rows, baseline)
    for entry in entries:
        row = rows.get(entry.migration_id)
        _assert_checksum(entry, row)
        covered = (
            baseline is not None
            and entry.numeric_version is not None
            and entry.numeric_version <= baseline
        )
        if not covered and (row is None or row.get("status") != "applied"):
            return None
    return max(
        (entry.numeric_version for entry in entries if entry.numeric_version is not None),
        default=None,
    )
