"""Owner-only views of saved provider search results, separate from a sale version."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid5

from sqlalchemy import text

from hushh_mcp.services.drive_document_facts_store import seal_evidence
from hushh_mcp.services.drive_live_reader import _open_url
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_period_packet_contract import PacketPeriod
from hushh_mcp.services.drive_request_discovery import discovery_evidence_matches
from hushh_mcp.services.google_drive_adapter import DriveReadError


def search_client_id(row):
    identity = UUID(str(row["packet_id"]))
    # Revision one is the original packet job, including queued pre-fix users.
    return (
        str(uuid5(identity, f"preview:{row['revision']}")) if row["revision"] > 1 else str(identity)
    )


def write_build(store, connection, row, build):
    connection.execute(
        text("""UPDATE drive_packet_heads SET build_envelope=CAST(:build AS jsonb)
      WHERE packet_id=:id AND revision=:revision"""),
        {
            "id": row["packet_id"],
            "revision": row["revision"],
            "build": seal_evidence(
                store.cipher, store._packet_identity(row, "build", row["revision"]), build
            ),
        },
    )


def rotate_preview(store, connection, row, build):
    # An unfrozen preview has no payment, grant or sharing effects to replay.
    # Advance its provenance rather than reinterpreting the old completed job.
    row = {**row, "revision": row["revision"] + 1}
    connection.execute(
        text("""UPDATE drive_packet_heads SET revision=:revision
      WHERE packet_id=:id"""),
        {"id": row["packet_id"], "revision": row["revision"]},
    )
    build = {
        key: value
        for key, value in build.items()
        if key not in {"search_job_id", "tagging", "tagging_work", "lease_kind"}
    }
    build["refresh_pending"] = True
    write_build(store, connection, row, build)
    return row, build


async def request_preview(store, *, user_id, packet_id, refresh=False):
    def operation(connection):
        active = store._period_access(connection, owner=user_id)
        row = store._row(
            connection,
            """SELECT * FROM drive_packet_heads WHERE user_id=:user
          AND packet_id=:id AND packet_kind='provider_discovery' FOR UPDATE""",
            {"user": user_id, "id": str(UUID(packet_id))},
        )
        if not row or row["connection_generation"] != active["connection_generation"]:
            raise DriveReadError("packet_unavailable")
        if row["current_version"]:
            return False
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if row["lease_expires_at"] and row["lease_expires_at"] > now:
            return False
        build = store._build(row)
        closed = PacketPeriod(
            start=row["period_start"], end=row["period_end"], timezone=row["period_timezone"]
        ).closed(now)
        if build.get("preview", {}).get("complete") and not build.get("refresh_pending"):
            searched_at = datetime.fromisoformat(build["preview"]["updatedAt"])
            if not refresh and not closed and now - searched_at < timedelta(minutes=5):
                return False
            row, build = rotate_preview(store, connection, row, build)
        build["requested_at"] = now.isoformat()
        write_build(store, connection, row, build)
        connection.execute(
            text("""UPDATE drive_packet_heads SET dirty=TRUE,next_at=clock_timestamp(),
          error_code=NULL,attempts=0 WHERE packet_id=:id"""),
            {"id": row["packet_id"]},
        )
        return True

    return await store._transaction(operation)


def document(source):
    return {
        "name": source["name"],
        "type": source.get("mimeType"),
        "pages": None,
        "period": None,
        "viewUrl": _open_url(source["id"], source.get("openUrl")),
        "shareable": source.get("shareable") is True,
        **({"packetTag": source["packetCandidateTag"]} if source.get("packetCandidateTag") else {}),
    }


def preview_summary(store, row):
    build = store._build(row)
    saved = build.get("preview", {})
    if not saved and row.get("current_version"):
        return {
            "status": "completed",
            "matched": row.get("document_count", 0),
            "revision": row["revision"],
            "complete": True,
            "stale": False,
            "updatedAt": row["updated_at"].isoformat(),
            "errorCode": None,
        }
    pending = build.get("refresh_pending", False) or bool(
        saved and build.get("search_job_id") and saved.get("job_id") != build["search_job_id"]
    )
    now = datetime.now(UTC)
    leased = bool(
        row.get("lease_expires_at")
        and row["lease_expires_at"] > now
        and build.get("lease_kind") != "tagging"
    )
    complete = saved.get("complete", False) and not pending
    status = (
        "searching"
        if leased
        else "completed"
        if complete
        else "failed"
        if row.get("error_code")
        else "partial"
        if saved.get("matched", 0) and not pending
        else "queued"
        if build.get("requested_at") or saved
        else "not_started"
    )
    return {
        "status": status,
        "revision": row["revision"],
        "matched": saved.get("matched"),
        "complete": complete,
        "stale": bool(saved and (pending or row.get("error_code") or saved.get("errorCode"))),
        "updatedAt": saved.get("updatedAt"),
        "errorCode": row.get("error_code") or saved.get("errorCode"),
        **({"tagging": build["tagging"]} if build.get("tagging") else {}),
    }


def _source_document(searches, item, *, user_id, search_id, head, checkpoint):
    source = searches.search_cipher.open(
        item["metadata_envelope"],
        user_id=user_id,
        resource_id=f"{search_id}:{item['position']}",
        purpose="owner-search-result",
    )
    if not discovery_evidence_matches(
        source,
        user_id=user_id,
        generation=head["connection_generation"],
        checkpoint=checkpoint,
    ):
        raise DriveReadError("packet_integrity_invalid")
    return document(source)


async def snapshot_search(store, job, build, search_job_id):
    """Save bounded usable output without publishing it or releasing the head lease."""
    searches = DriveOwnerSearchStore(db=store.db)

    def operation(connection):
        head = store.current_period_head(
            connection,
            user_id=job["user_id"],
            packet_id=job["packet_id"],
            revision=job["revision"],
            lease_id=job["lease_id"],
        )
        search = store._row(
            connection,
            """SELECT * FROM drive_owner_search_jobs
          WHERE user_id=:user AND job_id=:job AND period_packet_id=:packet FOR SHARE""",
            {"user": job["user_id"], "job": search_job_id, "packet": head["packet_id"]},
        )
        if not search or search["connection_generation"] != head["connection_generation"]:
            raise DriveReadError("packet_superseded")
        checkpoint = searches._checkpoint(search)
        store.validate_origin(head, checkpoint)
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()+INTERVAL '1 day' WHERE job_id=:id"
            ),
            {"id": search_job_id},
        )
        files = []
        for item in connection.execute(
            text("""SELECT position,metadata_envelope
          FROM drive_owner_search_results WHERE user_id=:user AND job_id=:job
          ORDER BY position LIMIT 120"""),
            {"user": job["user_id"], "job": search_job_id},
        ).mappings():
            files.append(
                {
                    "position": item["position"],
                    **_source_document(
                        searches,
                        item,
                        user_id=job["user_id"],
                        search_id=search_job_id,
                        head=head,
                        checkpoint=checkpoint,
                    ),
                }
            )
        complete = search["status"] == "completed" and not search["incomplete_search"]
        saved = {
            "job_id": str(search_job_id),
            "matched": search["matched"] if search["pages_scanned"] or complete else None,
            "complete": complete,
            "updatedAt": search["updated_at"].isoformat(),
            "errorCode": search["error_code"],
            "documents": files,
        }
        # Until the new scan has usable output, keep the last successful preview visible.
        updated = {**store._build(head), **build, "search_job_id": str(search_job_id)}
        if files or complete or not updated.get("preview"):
            updated.update(preview=saved, refresh_pending=False)
            from hushh_mcp.services.drive_packet_public_summary import update_preview_projection

            update_preview_projection(connection, head, saved, updated)
        write_build(store, connection, head, updated)
        if head["category"] == "financial":
            connection.execute(
                text("""UPDATE drive_packet_heads SET tagging_pending=TRUE,
              tagging_next_at=clock_timestamp() WHERE packet_id=:id"""),
                {"id": head["packet_id"]},
            )
        return updated

    return await store._transaction(operation)


async def read_preview(store, *, user_id, packet_id, cursor=None):
    searches = DriveOwnerSearchStore(db=store.db)

    def operation(connection):
        active = store._period_access(connection, owner=user_id)
        row = store._row(
            connection,
            """SELECT h.*,v.version,v.manifest_envelope FROM
          drive_packet_heads h LEFT JOIN drive_packet_versions v
          ON v.packet_id=h.packet_id AND v.version=h.current_version
          WHERE h.user_id=:user AND h.packet_id=:id AND h.packet_kind='provider_discovery'
          FOR SHARE OF h""",
            {"user": user_id, "id": str(UUID(packet_id))},
        )
        if not row or row["connection_generation"] != active["connection_generation"]:
            raise DriveReadError("packet_unavailable")
        build = store._build(row)
        summary = preview_summary(store, row)
        search_id = build.get("search_job_id")
        search = (
            store._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs
          WHERE user_id=:user AND job_id=:job AND period_packet_id=:packet
          AND connection_generation=:generation""",
                {
                    "user": user_id,
                    "job": search_id,
                    "packet": row["packet_id"],
                    "generation": row["connection_generation"],
                },
            )
            if search_id
            else None
        )
        if search and (
            not summary["stale"]
            or not build.get("refresh_pending")
            and build.get("preview", {}).get("job_id") == str(search["job_id"])
        ):
            checkpoint = searches._checkpoint(search)
            store.validate_origin(row, checkpoint)
            after = searches._after(user_id, search_id, cursor, connection=connection)
            items = list(
                connection.execute(
                    text("""SELECT position,metadata_envelope FROM
              drive_owner_search_results WHERE user_id=:user AND job_id=:job AND position>:after
              ORDER BY position LIMIT 26"""),
                    {"user": user_id, "job": search_id, "after": after},
                ).mappings()
            )
            documents = []
            for item in items[:25]:
                documents.append(
                    _source_document(
                        searches,
                        item,
                        user_id=user_id,
                        search_id=search_id,
                        head=row,
                        checkpoint=checkpoint,
                    )
                )
            return {
                **summary,
                "documents": documents,
                "nextCursor": searches._cursor(user_id, search_id, items[24]["position"])
                if len(items) > 25
                else None,
                "limited": False,
            }
        return _saved_page(store, searches, row, build, summary, user_id, cursor)

    return await store._transaction(operation)


def _saved_page(store, searches, row, build, summary, user_id, cursor):
    saved = build.get("preview", {})
    if not saved and row["version"]:
        manifest = store._manifest(row)
        saved = {
            "job_id": str(row["packet_id"]),
            "documents": [
                {"position": i + 1, **document(source)}
                for i, source in enumerate(manifest.get("source_metadata", {}).values())
            ],
            "matched": len(manifest.get("sources", [])),
        }
        summary.update(status="completed", matched=saved["matched"], complete=True)
    identity = saved.get("job_id", str(row["packet_id"]))
    after = searches._after(user_id, identity, cursor)
    items = [file for file in saved.get("documents", []) if file["position"] > after]
    return {
        **summary,
        "documents": [
            {key: value for key, value in file.items() if key != "position"} for file in items[:25]
        ],
        "nextCursor": searches._cursor(user_id, identity, items[24]["position"])
        if len(items) > 25
        else None,
        "limited": (saved.get("matched") or 0) > len(saved.get("documents", [])),
    }
