"""The SAME oracle, run against the pod-local SQLite engine.

This is the S3 gate: every scenario that passed against the real stored
procedures must pass unchanged here. The oracle was proven first (S2), so a
green run is evidence about the ENGINE, not about the tests.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Optional

import pytest

from hushh_mcp.services.pkm_sqlite_engine import SqlitePkmWriteEngine
from tests.pkm_conformance import oracle


class _SqlitePeer:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.engine = SqlitePkmWriteEngine(str(path))

    async def create_user(self, user_id: str) -> None:
        # The pod store has no FK spine to satisfy: the pod IS one user.
        return None

    async def read_domain_summary(self, user_id: str, domain: str) -> Optional[dict]:
        conn = sqlite3.connect(self.path)
        try:
            row = conn.execute(
                "SELECT domain_summaries FROM pkm_index WHERE user_id=?", (user_id,)
            ).fetchone()
        finally:
            conn.close()
        if row is None or not row[0]:
            return None
        return json.loads(row[0]).get(domain)


@pytest.fixture()
def peer(tmp_path: Path) -> _SqlitePeer:
    return _SqlitePeer(tmp_path / "pkm.sqlite3")


@pytest.mark.asyncio
async def test_every_scenario_passes_against_the_sqlite_engine(peer: _SqlitePeer):
    executed = await oracle.run_all(peer)
    assert executed == [s.__name__ for s in oracle.SCENARIOS]
    assert len(executed) == 9


@pytest.mark.asyncio
async def test_a_kill_mid_write_leaves_no_torn_state(peer: _SqlitePeer, tmp_path: Path):
    """Atomicity across tables -- the property the stored procedure owned.

    Force a failure INSIDE the commit transaction (a duplicate segment violates
    the pkm_blobs primary key mid-insert) and assert nothing from the failed
    commit is visible anywhere: no blobs advanced, no commit row, no archive.
    """
    user_id, _ = await oracle._fresh_committed_user(peer, "torn")

    import uuid

    params = oracle._commit_params(
        user_id, expected=1, next_revision=2, commit_id=str(uuid.uuid4())
    )
    params["p_segment_rows"] = oracle._segments(2) + oracle._segments(2)  # duplicate PK

    with pytest.raises(sqlite3.IntegrityError):
        await peer.engine.commit_domain_mutation(params)

    snapshot = oracle.unwrap(
        await peer.engine.get_domain_snapshot(
            {"p_user_id": user_id, "p_domain": oracle.DOMAIN, "p_segment_ids": []}
        ),
        "get_pkm_domain_snapshot_v1",
    )
    assert int(snapshot["content_revision"]) == 1
    assert snapshot["segments"]["root"]["ciphertext"] == "cipher-root-v1"

    conn = sqlite3.connect(peer.path)
    try:
        commits = conn.execute(
            "SELECT COUNT(*) FROM pkm_domain_commits WHERE user_id=?", (user_id,)
        ).fetchone()[0]
        revisions = conn.execute(
            "SELECT COUNT(*) FROM pkm_domain_revisions WHERE user_id=?", (user_id,)
        ).fetchone()[0]
    finally:
        conn.close()
    assert commits == 1  # only the seed commit
    assert revisions == 0  # the failed commit's archive rolled back with it
