"""A commit id binds one payload, one owner, one domain, one expected revision.

The SQLite pod engine looked a replayed commit up by ``commit_id`` alone and then
compared ``request_fingerprint`` and nothing else. The Postgres engine it must be
conformant with raises ``pkm_*_commit_binding_mismatch`` when any of ``user_id``,
``domain``, ``commit_kind`` or the expected revisions differ
(``db/migrations/098_pkm_v7_recovery_foundation.sql:1274-1284``).

So a replay carrying a DIFFERENT ``user_id`` fell through to the success return:
it reported ``success=True, idempotent_replay=True`` for a write that never
happened, and skipped the ``expected != current`` optimistic-concurrency check on
the way past. A fabricated success and an OCC bypass in one call.

The conformance oracle never caught it because it only varies the fingerprint for
a single user — the engine passed on the one axis it was asked about while being
strictly weaker on four others. That is the recurring shape in this repo: a test
written against one axis of a contract holds for exactly as long as nobody probes
another. These cases are the axes the oracle does not have.

Observed live: the 50-pod dev simulation's ``commit_binding_cross_user`` probe
failed on every pod, every cycle, until this binding was widened.
"""

from __future__ import annotations

import uuid

import pytest

from hushh_mcp.services.pkm_sqlite_engine import ERR_COMMIT_BINDING, SqlitePkmWriteEngine

OWNER = "HA1TEST0001"
OTHER = "HA1TEST0002"
DOMAIN = "finance"


@pytest.fixture
def engine(tmp_path) -> SqlitePkmWriteEngine:
    return SqlitePkmWriteEngine(str(tmp_path / "pkm.sqlite3"))


def _params(
    user_id: str,
    *,
    commit_id: str,
    expected: int,
    next_revision: int,
    domain: str = DOMAIN,
    commit_kind: str = "mutation",
    fingerprint: str | None = "fp-1",
) -> dict:
    return {
        "p_user_id": user_id,
        "p_domain": domain,
        "p_expected_content_revision": expected,
        "p_next_content_revision": next_revision,
        "p_commit_id": commit_id,
        "p_commit_kind": commit_kind,
        "p_request_fingerprint": fingerprint,
        "p_segment_rows": [],
        "p_manifest_row": {"manifest_version": next_revision},
        "p_path_rows": [],
        "p_scope_rows": [],
        "p_summary_patch": {},
        "p_event_rows": [],
    }


async def _seed(engine: SqlitePkmWriteEngine, commit_id: str) -> None:
    await engine.commit_domain_mutation(
        _params(OWNER, commit_id=commit_id, expected=0, next_revision=1)
    )


async def test_same_owner_identical_replay_is_still_idempotent(engine) -> None:
    """The widened binding must not break the behaviour it is protecting."""
    commit_id = f"c-{uuid.uuid4()}"
    await _seed(engine, commit_id)

    replay = await engine.commit_domain_mutation(
        _params(OWNER, commit_id=commit_id, expected=0, next_revision=1)
    )

    assert replay["success"] is True
    assert replay["idempotent_replay"] is True


@pytest.mark.parametrize(
    ("field", "params"),
    [
        pytest.param(
            "user_id",
            lambda cid: _params(OTHER, commit_id=cid, expected=0, next_revision=1),
            id="different-owner",
        ),
        pytest.param(
            "user_id+expected",
            # The exact shape the live simulation replayed: another owner AND an
            # absurd expected revision. Both must be refused, and the refusal must
            # not depend on the revision being absurd.
            lambda cid: _params(OTHER, commit_id=cid, expected=99, next_revision=1),
            id="different-owner-and-absurd-revision",
        ),
        pytest.param(
            "domain",
            lambda cid: _params(OWNER, commit_id=cid, expected=0, next_revision=1, domain="health"),
            id="different-domain",
        ),
        pytest.param(
            "commit_kind",
            lambda cid: _params(
                OWNER, commit_id=cid, expected=0, next_revision=1, commit_kind="upgrade"
            ),
            id="different-commit-kind",
        ),
        pytest.param(
            "expected_content_revision",
            lambda cid: _params(OWNER, commit_id=cid, expected=99, next_revision=1),
            id="different-expected-revision",
        ),
        pytest.param(
            "request_fingerprint",
            lambda cid: _params(OWNER, commit_id=cid, expected=0, next_revision=1, fingerprint="fp-2"),
            id="different-fingerprint",
        ),
    ],
)
async def test_rebound_commit_id_is_refused(engine, field: str, params) -> None:
    commit_id = f"c-{uuid.uuid4()}"
    await _seed(engine, commit_id)

    with pytest.raises(RuntimeError) as excinfo:
        await engine.commit_domain_mutation(params(commit_id))

    assert ERR_COMMIT_BINDING in str(excinfo.value), (
        f"rebinding {field} on an existing commit_id must raise {ERR_COMMIT_BINDING}"
    )


async def test_cross_owner_replay_never_bypasses_optimistic_concurrency(engine) -> None:
    """The failure mode, stated as its consequence rather than its mechanism.

    Before the fix this call returned ``success=True`` while writing nothing and
    while never reaching the ``expected != current`` check. A caller could not tell
    that from a real commit.
    """
    commit_id = f"c-{uuid.uuid4()}"
    await _seed(engine, commit_id)

    with pytest.raises(RuntimeError):
        await engine.commit_domain_mutation(
            _params(OTHER, commit_id=commit_id, expected=99, next_revision=1)
        )

    # And the other owner's domain must still be untouched — a refused replay is
    # not allowed to have been a partial write.
    read = await engine.commit_domain_mutation(
        _params(OTHER, commit_id=f"c-{uuid.uuid4()}", expected=0, next_revision=1)
    )
    assert read["success"] is True, "the refused replay must not have advanced OTHER's revision"
