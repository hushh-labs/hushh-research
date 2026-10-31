"""Pinned source and clock records for exact Production guard history rows."""

from __future__ import annotations

from dataclasses import dataclass

import retention_preflight_evidence as base

PUBLICATION = "scripts/ci/retention_publication.py"

CLOCK_BOUND_SOURCE_PROFILES = {
    "publication-939f": {
        base.OWNER: ("1e7f8973cea0f5fea7ada3033935856bb4428f37", 87255),
        base.WORKFLOW: ("8f0660ff9a8ec42747dc338e56ad83e3dde98ce5", 20685),
        PUBLICATION: ("939f07cd6f1330375544983279d5e801e4e5a260", 18759),
    },
    "publication-98e": {
        base.OWNER: ("1e7f8973cea0f5fea7ada3033935856bb4428f37", 87255),
        base.WORKFLOW: ("8f0660ff9a8ec42747dc338e56ad83e3dde98ce5", 20685),
        PUBLICATION: ("98e190df4afcfac18f093abfe77dc3cbe242d831", 18042),
    },
}


@dataclass(frozen=True)
class ClockEvidence:
    run_id: int
    event: str
    title: str
    actor: str
    head_sha: str
    created_at: str
    check_job_id: int
    check_completed_at: str
    wake_job_id: int
    wake_completed_at: str
    tick_completed_at: str


@dataclass(frozen=True)
class ClockBoundRecord:
    worker_head_sha: str
    worker_created_at: str
    worker_job_id: int
    worker_job_started_at: str
    worker_job_completed_at: str
    source_profile: str
    diagnostic_sha256: str
    clock: ClockEvidence
    worker_checkout_sha: str | None = None
    worker_display_title: str = "Capacity Maintenance"


# These are the complete production history rows between the last trusted Save
# checkpoint and the first subsequent saved checkpoint. Each clock wake is
# source-pinned and creates only the generic tick after both checks succeed.
_PUBLICATION_DIAGNOSTIC_SHA256 = (
    "8ee868f76c8d7b4061b1df961ad0c99add05c323e55482e5b80b4fc704c79bd8"
)
CLOCK_BOUND_RECORDS = {
    41173362210: ClockBoundRecord(
        worker_head_sha="ef062f1a406062301a8b9df319830742b6b05d55",
        worker_created_at="2026-10-31T05:37:47Z",
        worker_job_id=124456008994,
        worker_job_started_at="2026-10-31T05:39:04Z",
        worker_job_completed_at="2026-10-31T05:40:57Z",
        source_profile="publication-939f",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41173284540,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 466",
            actor="github-actions[bot]",
            head_sha="ef062f1a406062301a8b9df319830742b6b05d55",
            created_at="2026-10-31T05:36:35Z",
            check_job_id=124455548698,
            check_completed_at="2026-10-31T05:37:36Z",
            wake_job_id=124455744386,
            wake_completed_at="2026-10-31T05:37:47Z",
            tick_completed_at="2026-10-31T05:37:45Z",
        ),
        worker_checkout_sha="ef062f1a406062301a8b9df319830742b6b05d55",
        worker_display_title="Capacity Maintenance tick (production)",
    ),
    41169264544: ClockBoundRecord(
        worker_head_sha="f362f9dfaa55ff34e2b2c655f4d82ca5fdf36eea",
        worker_created_at="2026-10-31T04:36:28Z",
        worker_job_id=124443670919,
        worker_job_started_at="2026-10-31T04:37:34Z",
        worker_job_completed_at="2026-10-31T04:40:02Z",
        source_profile="publication-939f",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41169161079,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 465",
            actor="github-actions[bot]",
            head_sha="f362f9dfaa55ff34e2b2c655f4d82ca5fdf36eea",
            created_at="2026-10-31T04:35:00Z",
            check_job_id=124443160959,
            check_completed_at="2026-10-31T04:36:21Z",
            wake_job_id=124443441348,
            wake_completed_at="2026-10-31T04:36:27Z",
            tick_completed_at="2026-10-31T04:36:25Z",
        ),
        worker_checkout_sha="f362f9dfaa55ff34e2b2c655f4d82ca5fdf36eea",
        worker_display_title="Capacity Maintenance tick (production)",
    ),
    41164989434: ClockBoundRecord(
        worker_head_sha="8aba341a25c83082ecff40b926c48267b99ed764",
        worker_created_at="2026-10-31T03:34:52Z",
        worker_job_id=124430866542,
        worker_job_started_at="2026-10-31T03:36:33Z",
        worker_job_completed_at="2026-10-31T03:38:51Z",
        source_profile="publication-939f",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41164857246,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 464",
            actor="github-actions[bot]",
            head_sha="8aba341a25c83082ecff40b926c48267b99ed764",
            created_at="2026-10-31T03:33:05Z",
            check_job_id=124430110643,
            check_completed_at="2026-10-31T03:34:36Z",
            wake_job_id=124430442023,
            wake_completed_at="2026-10-31T03:34:52Z",
            tick_completed_at="2026-10-31T03:34:50Z",
        ),
    ),
    41160506962: ClockBoundRecord(
        worker_head_sha="fd254cd2bfee31cd7af82fd8d2463d01028c2b38",
        worker_created_at="2026-10-31T02:32:59Z",
        worker_job_id=124417204655,
        worker_job_started_at="2026-10-31T02:34:50Z",
        worker_job_completed_at="2026-10-31T02:37:03Z",
        source_profile="publication-939f",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41160309188,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 463",
            actor="github-actions[bot]",
            head_sha="fd254cd2bfee31cd7af82fd8d2463d01028c2b38",
            created_at="2026-10-31T02:30:29Z",
            check_job_id=124416207019,
            check_completed_at="2026-10-31T02:32:54Z",
            wake_job_id=124416775596,
            wake_completed_at="2026-10-31T02:32:58Z",
            tick_completed_at="2026-10-31T02:32:57Z",
        ),
        worker_checkout_sha="8aba341a25c83082ecff40b926c48267b99ed764",
    ),
    41155661193: ClockBoundRecord(
        worker_head_sha="fd254cd2bfee31cd7af82fd8d2463d01028c2b38",
        worker_created_at="2026-10-31T01:30:21Z",
        worker_job_id=124402208231,
        worker_job_started_at="2026-10-31T01:32:07Z",
        worker_job_completed_at="2026-10-31T01:34:07Z",
        source_profile="publication-939f",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41155526005,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 462",
            actor="github-actions[bot]",
            head_sha="fd254cd2bfee31cd7af82fd8d2463d01028c2b38",
            created_at="2026-10-31T01:28:39Z",
            check_job_id=124401372373,
            check_completed_at="2026-10-31T01:30:16Z",
            wake_job_id=124401760601,
            wake_completed_at="2026-10-31T01:30:20Z",
            tick_completed_at="2026-10-31T01:30:19Z",
        ),
    ),
    41150358309: ClockBoundRecord(
        worker_head_sha="8a825bf37644c82c273d85c6cf7ddec8c4a39461",
        worker_created_at="2026-10-31T00:28:32Z",
        worker_job_id=124385650739,
        worker_job_started_at="2026-10-31T00:30:14Z",
        worker_job_completed_at="2026-10-31T00:32:01Z",
        source_profile="publication-939f",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41144284837,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 459",
            actor="github-actions[bot]",
            head_sha="8811e51078e5ba484d0f9fc9fc795b88c6c0ea06",
            created_at="2026-10-30T23:24:28Z",
            check_job_id=124384552975,
            check_completed_at="2026-10-31T00:28:16Z",
            wake_job_id=124385093563,
            wake_completed_at="2026-10-31T00:28:32Z",
            tick_completed_at="2026-10-31T00:28:30Z",
        ),
    ),
    41144469026: ClockBoundRecord(
        worker_head_sha="8811e51078e5ba484d0f9fc9fc795b88c6c0ea06",
        worker_created_at="2026-10-30T23:26:18Z",
        worker_job_id=124366767414,
        worker_job_started_at="2026-10-30T23:28:09Z",
        worker_job_completed_at="2026-10-30T23:30:01Z",
        source_profile="publication-939f",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41137719392,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 458",
            actor="github-actions[bot]",
            head_sha="69b50e86342c79c17363e769df693992c80f643f",
            created_at="2026-10-30T22:22:42Z",
            check_job_id=124365591102,
            check_completed_at="2026-10-30T23:26:11Z",
            wake_job_id=124366156280,
            wake_completed_at="2026-10-30T23:26:17Z",
            tick_completed_at="2026-10-30T23:26:15Z",
        ),
    ),
    41137901974: ClockBoundRecord(
        worker_head_sha="69b50e86342c79c17363e769df693992c80f643f",
        worker_created_at="2026-10-30T22:24:20Z",
        worker_job_id=124345520473,
        worker_job_started_at="2026-10-30T22:26:23Z",
        worker_job_completed_at="2026-10-30T22:28:26Z",
        source_profile="publication-98e",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41132833866,
            event="schedule",
            title="Capacity clock · schedule · run 457",
            actor="ankitkumarsingh1702",
            head_sha="69b50e86342c79c17363e769df693992c80f643f",
            created_at="2026-10-30T21:40:58Z",
            check_job_id=124344184010,
            check_completed_at="2026-10-30T22:24:14Z",
            wake_job_id=124344745588,
            wake_completed_at="2026-10-30T22:24:20Z",
            tick_completed_at="2026-10-30T22:24:18Z",
        ),
    ),
    41130582923: ClockBoundRecord(
        worker_head_sha="35749fde6c14f218c3b5995f00384ccfe2103038",
        worker_created_at="2026-10-30T21:22:36Z",
        worker_job_id=124320957053,
        worker_job_started_at="2026-10-30T21:26:24Z",
        worker_job_completed_at="2026-10-30T21:28:38Z",
        source_profile="publication-98e",
        diagnostic_sha256=_PUBLICATION_DIAGNOSTIC_SHA256,
        clock=ClockEvidence(
            run_id=41130350440,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 456",
            actor="github-actions[bot]",
            head_sha="35749fde6c14f218c3b5995f00384ccfe2103038",
            created_at="2026-10-30T21:20:46Z",
            check_job_id=124319338876,
            check_completed_at="2026-10-30T21:22:30Z",
            wake_job_id=124320092724,
            wake_completed_at="2026-10-30T21:22:34Z",
            tick_completed_at="2026-10-30T21:22:34Z",
        ),
    ),
    41122398815: ClockBoundRecord(
        worker_head_sha="ce8e5bb943af5453a9936ae5b6f45ec88c1e16e0",
        worker_created_at="2026-10-30T20:20:36Z",
        worker_job_id=124292675340,
        worker_job_started_at="2026-10-30T20:22:53Z",
        worker_job_completed_at="2026-10-30T20:24:49Z",
        source_profile="publication-98e",
        diagnostic_sha256="0efacb4d954ffadfff3a94d96f16dc01532ac14525d852101661892d3dd1735e",
        clock=ClockEvidence(
            run_id=41122106303,
            event="repository_dispatch",
            title="Capacity clock · repository_dispatch · run 455",
            actor="github-actions[bot]",
            head_sha="faa8abdfec4c2bde32e4a2de75266744b08c62af",
            created_at="2026-10-30T20:18:29Z",
            check_job_id=124290535476,
            check_completed_at="2026-10-30T20:20:27Z",
            wake_job_id=124291625575,
            wake_completed_at="2026-10-30T20:20:36Z",
            tick_completed_at="2026-10-30T20:20:33Z",
        ),
    ),
}
