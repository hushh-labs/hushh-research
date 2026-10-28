"""Candidate-only tag claims. Never mutate whole-Drive opt-in or sale manifests."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_owner_cohort
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_period_packet_preview import document, write_build
from hushh_mcp.services.drive_request_discovery import discovery_evidence_matches
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import admit_hub_content

POLICY = "financial-packet-organizing-v1"
BATCH = 8
# Fixed codes from the credential path. Anything else, such as a raw provider
# message, collapses to oauth_unavailable and never reaches a log or saved state.
OAUTH_FAILURE_CODES = frozenset(
    {
        "connector_unavailable",
        "invalid_argument",
        "reconnect_required",
        "connection_changed",
        "insufficient_scope",
        "unexpected_scope",
        "connector_configuration_invalid",
        "refresh_in_progress",
        "provider_unavailable",
        "provider_response_invalid",
        "provider_response_too_large",
        "grant_rejected",
        "identity_not_verified",
        "profile_unavailable",
    }
)
LIFECYCLE_FAILURE_CODES = frozenset(
    {"connector_storage_unavailable", "connector_unavailable", "revocation_in_progress"}
)
# The only failure codes saved with an attempt, and so the only ones an owner can see.
FAILURE_CODES = (
    OAUTH_FAILURE_CODES
    | LIFECYCLE_FAILURE_CODES
    | {"oauth_unavailable", "processing_timeout", "processing_unavailable"}
)
QUICK_RETRY_ATTEMPTS = 3
QUICK_RETRY_SECONDS = 300
# Failures that pass on their own (refresh contention, provider or storage
# unavailability, a slow batch) get a few slow retries before organizing stops,
# so recovery needs no operator database write. Retries stay bounded.
TRANSIENT_FAILURE_CODES = frozenset(
    {
        "refresh_in_progress",
        "provider_unavailable",
        "connector_storage_unavailable",
        "processing_timeout",
    }
)
SLOW_RETRY_ATTEMPTS = 7
SLOW_RETRY_SECONDS = 6 * 3600


def current(store, connection, job):
    active = store._period_access(connection, owner=job["user_id"])
    row = store._row(
        connection,
        """SELECT * FROM drive_packet_heads
      WHERE user_id=:user AND packet_id=:id FOR UPDATE""",
        {"user": job["user_id"], "id": job["packet_id"]},
    )
    build = store._build(row) if row else {}
    preference = store._row(
        connection,
        "SELECT revision FROM drive_live_preferences WHERE user_id=:user",
        {"user": job["user_id"]},
    )
    if (
        not row
        or active["connection_generation"] != job["connection_generation"]
        or row["connection_generation"] != job["connection_generation"]
        or row["revision"] != job["revision"]
        or str(row["lease_id"]) != job["lease_id"]
        or not row["lease_expires_at"]
        or row["lease_expires_at"] <= datetime.now(UTC)
        or build.get("lease_kind") != "tagging"
        or build.get("search_job_id") != job["search_id"]
        or (preference["revision"] if preference else 0) != job["background_revision"]
    ):
        raise DriveReadError("packet_superseded")
    search = store._row(
        connection,
        """SELECT * FROM drive_owner_search_jobs WHERE job_id=:job
        AND user_id=:user AND period_packet_id=:packet AND connection_generation=:generation FOR SHARE""",
        {
            "job": job["search_id"],
            "user": job["user_id"],
            "packet": job["packet_id"],
            "generation": job["connection_generation"],
        },
    )
    if not search:
        raise DriveReadError("packet_superseded")
    store.validate_origin(row, DriveOwnerSearchStore(db=store.db)._checkpoint(search))
    return row, build


def candidate_batch(store, searches, connection, row, search_id, checkpoint, cursor):
    owner = row["user_id"]
    rows = []
    for item in connection.execute(
        text("""SELECT position,metadata_envelope FROM drive_owner_search_results
      WHERE job_id=:job AND user_id=:user AND position>:after ORDER BY position LIMIT :limit"""),
        {"job": search_id, "user": owner, "after": cursor, "limit": BATCH},
    ).mappings():
        source = searches.search_cipher.open(
            item["metadata_envelope"],
            user_id=owner,
            resource_id=f"{search_id}:{item['position']}",
            purpose="owner-search-result",
        )
        if not discovery_evidence_matches(
            source,
            user_id=owner,
            generation=row["connection_generation"],
            checkpoint=checkpoint,
        ):
            raise DriveReadError("packet_integrity_invalid")
        rows.append({"position": item["position"], "source": source})
    return rows


def tagging_work(build, search_id, model_version):
    work = build.get("tagging_work", {})
    if work.get("search_id") != search_id or work.get("model_version") != model_version:
        work = {
            "search_id": search_id,
            "model_version": model_version,
            "cursor": 0,
            "counts": {"financial": 0, "review": 0, "other": 0},
            "attempts": 0,
            "started_at": datetime.now(UTC).isoformat(),
        }
    return work


def source_search(store, connection, row, search_id):
    owner = row["user_id"]
    search = (
        store._row(
            connection,
            """SELECT * FROM drive_owner_search_jobs WHERE
      user_id=:user AND job_id=:job AND period_packet_id=:packet AND connection_generation=:generation""",
            {
                "user": owner,
                "job": search_id,
                "packet": row["packet_id"],
                "generation": row["connection_generation"],
            },
        )
        if search_id
        else None
    )
    return search


async def _claim_owner(store, model_version, owner):
    searches = DriveOwnerSearchStore(db=store.db)

    def operation(connection):
        candidates = list(
            connection.execute(
                text("""SELECT h.packet_id,h.user_id FROM drive_packet_heads h
          JOIN user_external_connector_connections c ON c.user_id=h.user_id AND c.connector_id='google_drive'
          LEFT JOIN drive_live_preferences p ON p.user_id=h.user_id
          WHERE h.user_id=:owner AND h.tagging_pending AND h.category='financial' AND h.packet_kind='provider_discovery'
            AND c.status='connected' AND c.connection_generation=h.connection_generation
            AND (p.user_id IS NULL OR p.background_enabled) AND h.tagging_next_at<=clock_timestamp()
            AND (h.lease_id IS NULL OR h.lease_expires_at<=clock_timestamp())
          ORDER BY h.tagging_next_at,h.packet_id LIMIT 1"""),
                {"owner": owner},
            ).mappings()
        )
        for candidate in candidates:
            store._period_access(connection, owner=owner)
            row = store._row(
                connection,
                """SELECT * FROM drive_packet_heads WHERE packet_id=:id
              AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED""",
                {"id": candidate["packet_id"]},
            )
            if not row:
                continue
            build = store._build(row)
            search_id = build.get("search_job_id")
            search = source_search(store, connection, row, search_id)
            if not search:
                connection.execute(
                    text("UPDATE drive_packet_heads SET tagging_pending=FALSE WHERE packet_id=:id"),
                    {"id": row["packet_id"]},
                )
                continue
            checkpoint = searches._checkpoint(search)
            store.validate_origin(row, checkpoint)
            work = tagging_work(build, search_id, model_version)
            preference = store._row(
                connection,
                "SELECT revision FROM drive_live_preferences WHERE user_id=:user",
                {"user": owner},
            )
            lease = str(uuid4())
            build.update(lease_kind="tagging", tagging_work=work)
            build["tagging"] = {
                "status": "running",
                "policyVersion": POLICY,
                "counts": {
                    **work["counts"],
                    "pending": max(0, search["matched"] - sum(work["counts"].values())),
                },
            }
            write_build(store, connection, row, build)
            connection.execute(
                text("""UPDATE drive_packet_heads SET lease_id=:lease,
              lease_expires_at=clock_timestamp()+INTERVAL '180 seconds' WHERE packet_id=:id"""),
                {"lease": lease, "id": row["packet_id"]},
            )
            rows = candidate_batch(
                store, searches, connection, row, search_id, checkpoint, work["cursor"]
            )
            return {
                **row,
                "user_id": owner,
                "lease_id": lease,
                "search_id": search_id,
                "build": build,
                "background_revision": preference["revision"] if preference else 0,
                "items": rows,
                "matched": search["matched"],
                "complete": search["status"] == "completed" and not search["incomplete_search"],
            }
        return None

    return await store._transaction(operation)


async def claim(store, model_version):
    # No private metadata is read until the owner's placement has been admitted.
    cohort = connector_feature_owner_cohort("drive_period_packets", "google_drive_live")
    if cohort == ():
        return None

    def owners(connection):
        return list(
            connection.execute(
                text("""SELECT user_id FROM drive_packet_heads WHERE tagging_pending
            AND category='financial' AND tagging_next_at<=clock_timestamp()
            AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
            AND (:all_owners OR user_id=ANY(CAST(:owners AS text[])))
            GROUP BY user_id ORDER BY min(tagging_next_at),user_id LIMIT 20"""),
                {"all_owners": cohort is None, "owners": list(cohort or ())},
            ).scalars()
        )

    async def defer_owner(owner):
        # Queue housekeeping only: no content, authorization or OFF preference changes.
        await store._transaction(
            lambda connection: connection.execute(
                text("""UPDATE drive_packet_heads SET tagging_next_at=clock_timestamp()+INTERVAL '5 minutes'
              WHERE user_id=:owner AND tagging_pending AND tagging_next_at<=clock_timestamp()
                AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())"""),
                {"owner": owner},
            )
        )

    for owner in await store._transaction(owners):
        try:
            await admit_hub_content(owner, "drive_period_packets")
            job = await _claim_owner(store, model_version, owner)
            if job:
                return job
        except (DriveReadError, HTTPException, PermissionError, ConnectorLifecycleError):
            pass
        await defer_owner(owner)
    return None


async def cached(store, job, model_version):
    """Reuse candidate-only compatible placements, honoring exact-source owner fixes."""
    from hushh_mcp.services.drive_group_index_store import DriveGroupCipher

    cipher = DriveGroupCipher()

    def operation(connection):
        current(store, connection, job)
        result = {}
        for item in job["items"]:
            source = item["source"]
            if not source.get("sourceVersion"):
                continue
            ref = cipher.ref(job["user_id"], source["id"])
            row = store._row(
                connection,
                """SELECT * FROM drive_group_index WHERE user_id=:user
                AND source_ref=:ref AND connection_generation=:generation AND source_version=:version
                AND source_modified=CAST(:modified AS timestamptz)
                AND (group_source='owner' OR model_version=:model)""",
                {
                    "user": job["user_id"],
                    "ref": ref,
                    "generation": job["connection_generation"],
                    "version": source["sourceVersion"],
                    "modified": source.get("modifiedTime"),
                    "model": model_version,
                },
            )
            if row and cipher.open_entry(row).get("id") == source["id"]:
                result[source["id"]] = {
                    "group": None if row["shelf"] == "kept" else row["shelf"],
                    "reason": row["reason"],
                    "groupSource": row["group_source"],
                    "modelVersion": row["model_version"],
                    "reused": True,
                }
        return result

    return await store._transaction(operation)


async def require_current(store, job):
    await store._transaction(lambda connection: current(store, connection, job))


RECOVERY_MARKER = "unrecorded-failure-rearm-v1"
# Every stop recorded from now on carries a failure code. Rows last scheduled
# before this point are the only ones that can lack one, so the pass retires itself.
UNRECORDED_BEFORE = datetime(2026, 10, 30, tzinfo=UTC)


def _unrecorded_stop(store, head):
    """The sealed build of a stop saved without its cause, else None."""
    try:
        build = store._build(head)
    except DriveReadError:
        return None  # Advisory recovery never blocks the owner's discovery.
    tagging, work = build.get("tagging") or {}, build.get("tagging_work") or {}
    if (
        tagging.get("status") != "failed"
        or tagging.get("failureCode")
        or work.get("recovery") == RECOVERY_MARKER
    ):
        return None
    return build


def rearm_unrecorded_failures(store, connection, *, user_id, generation):
    """Re-arm, once per packet, organizing that stopped before causes were recorded.

    Those stops came from a refresh race fixed alongside this marker. The re-armed
    packet gets a fresh bounded retry budget; saved labels and the cursor are kept.
    Recovery needs no operator database write, and only qualifying rows are locked.
    """
    candidates = connection.execute(
        text("""SELECT * FROM drive_packet_heads WHERE user_id=:user
      AND connection_generation=:generation AND packet_kind='provider_discovery'
      AND category='financial' AND NOT tagging_pending AND build_envelope IS NOT NULL
      AND tagging_next_at<:before"""),
        {"user": user_id, "generation": generation, "before": UNRECORDED_BEFORE},
    ).mappings()
    for candidate in [dict(row) for row in candidates]:
        if _unrecorded_stop(store, candidate) is None:
            continue
        head = store._row(
            connection,
            """SELECT * FROM drive_packet_heads WHERE packet_id=:id AND revision=:revision
          AND NOT tagging_pending AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
          FOR UPDATE SKIP LOCKED""",
            {"id": candidate["packet_id"], "revision": candidate["revision"]},
        )
        build = _unrecorded_stop(store, head) if head else None
        if build is None:
            continue
        build["tagging_work"] = {
            **build["tagging_work"],
            "attempts": 0,
            "recovery": RECOVERY_MARKER,
        }
        write_build(store, connection, head, build)
        connection.execute(
            text("""UPDATE drive_packet_heads SET tagging_pending=TRUE,
          tagging_next_at=clock_timestamp() WHERE packet_id=:id"""),
            {"id": head["packet_id"]},
        )


def _retry_after(error, attempts):
    """Seconds until the next attempt after a failed batch, or None when organizing stops."""
    limit = SLOW_RETRY_ATTEMPTS if error in TRANSIENT_FAILURE_CODES else QUICK_RETRY_ATTEMPTS
    if attempts >= limit:
        return None
    return QUICK_RETRY_SECONDS if attempts < QUICK_RETRY_ATTEMPTS else SLOW_RETRY_SECONDS


def _save_tags(store, searches, connection, job, build, tags):
    """Seal each label into its original result, only while that source is unchanged."""
    work = build["tagging_work"]
    for item, tag in zip(job["items"], tags, strict=True):
        fresh = store._row(
            connection,
            """SELECT metadata_envelope FROM drive_owner_search_results
            WHERE user_id=:user AND job_id=:job AND position=:position FOR UPDATE""",
            {"user": job["user_id"], "job": job["search_id"], "position": item["position"]},
        )
        if not fresh:
            raise DriveReadError("packet_superseded")
        source = searches.search_cipher.open(
            fresh["metadata_envelope"],
            user_id=job["user_id"],
            resource_id=f"{job['search_id']}:{item['position']}",
            purpose="owner-search-result",
        )
        if {k: v for k, v in source.items() if k != "packetCandidateTag"} != {
            k: v for k, v in item["source"].items() if k != "packetCandidateTag"
        }:
            raise DriveReadError("packet_superseded")
        source["packetCandidateTag"] = tag
        changed = connection.execute(
            text("""UPDATE drive_owner_search_results SET metadata_envelope=CAST(:metadata AS jsonb)
          WHERE user_id=:user AND job_id=:job AND position=:position"""),
            {
                "user": job["user_id"],
                "job": job["search_id"],
                "position": item["position"],
                "metadata": searches._seal(
                    source,
                    job["user_id"],
                    f"{job['search_id']}:{item['position']}",
                    "owner-search-result",
                ),
            },
        )
        if changed.rowcount != 1:
            raise DriveReadError("packet_superseded")
        work["cursor"] = item["position"]
        work["counts"][tag["bucket"]] += 1
        for saved in build.get("preview", {}).get("documents", []):
            if saved["position"] == item["position"]:
                saved.update(document(source))


async def commit(store, job, tags=None, error=None):
    """Save one organized batch, or one failed attempt identified by a fixed safe code."""
    if error is not None and error not in FAILURE_CODES:
        raise ValueError("A failed tagging attempt needs a fixed failure code")
    searches = DriveOwnerSearchStore(db=store.db)

    def operation(connection):
        row, build = current(store, connection, job)
        work = build["tagging_work"]
        if tags is not None:
            _save_tags(store, searches, connection, job, build, tags)
        work["attempts"] = work.get("attempts", 0) + 1 if error else 0
        remaining = max(0, job["matched"] - sum(work["counts"].values()))
        delay = _retry_after(error, work["attempts"]) if error else 0
        retry = bool(remaining) and delay is not None
        # A failed attempt with a scheduled retry is still queued work, not a failure,
        # and one with nothing left to sort leaves the finished result as it is.
        status = (
            "failed"
            if error and remaining and not retry
            else "queued"
            if remaining
            else "completed"
            if job["complete"]
            else "partial"
        )
        build.pop("lease_kind", None)
        if status == "completed":
            work["completed_at"] = datetime.now(UTC).isoformat()
        build["tagging"] = {
            "status": status,
            "policyVersion": POLICY,
            "counts": {**work["counts"], "pending": remaining},
            **({"failureCode": error} if error else {}),
            **(
                {"retryAt": (datetime.now(UTC) + timedelta(seconds=delay)).isoformat()}
                if error and retry
                else {}
            ),
        }
        write_build(store, connection, row, build)
        connection.execute(
            text("""UPDATE drive_packet_heads SET tagging_pending=:pending,
          tagging_next_at=clock_timestamp()+make_interval(secs=>:delay),lease_id=NULL,lease_expires_at=NULL
          WHERE packet_id=:id"""),
            {"id": row["packet_id"], "pending": retry, "delay": delay if retry else 0},
        )
        return "queued" if retry else status

    return await store._transaction(operation)
