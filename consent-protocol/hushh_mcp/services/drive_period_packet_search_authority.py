"""Typed origin and immutable checkpoint fences for the existing search store."""

from sqlalchemy import text

from hushh_mcp.services.google_drive_adapter import DriveReadError

SEMANTIC_COMMIT_KEYS = (
    "query_source",
    "semantic_plan",
    "semantic_plan_digest",
    "semantic_assessment_policy",
    "semantic_model_binding",
    "semantic_purpose",
    "period_packet_origin",
    "provider_packet",
    "reusable_packet",
    "evidence_route",
    "request_origin_id",
    "request_revision",
    "queries",
    "requested_period",
)


def admit_creation(store, connection, user_id, period_packet_id, checkpoint):
    connection.execute(
        text("""UPDATE drive_owner_search_jobs SET status='stopped',revision=revision+1,
        lease_id=NULL,lease_expires_at=NULL WHERE user_id=:user AND period_packet_id IS NOT NULL
        AND status IN ('queued','running') AND expires_at<=clock_timestamp()
        AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())"""),
        {"user": user_id},
    )
    if period_packet_id is not None:
        from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

        packet = DrivePeriodPacketStore(db=store.db).current_period_head(
            connection, user_id=user_id, packet_id=period_packet_id
        )
        DrivePeriodPacketStore.validate_origin(packet, checkpoint)
    else:
        # A queued preparation job must not block a person's real request.
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='stopped',
          revision=revision+1,updated_at=clock_timestamp()
          WHERE user_id=:user AND period_packet_id IS NOT NULL AND status IN ('queued','running')
            AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())"""),
            {"user": user_id},
        )


def require_period_origin(store, connection, job, row):
    from hushh_mcp.services.drive_owner_search_store import _semantic_binding_current

    period_origin = job["checkpoint"].get("period_packet_origin")
    if period_origin is not None:
        _semantic_binding_current(job["checkpoint"])
        from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

        head = DrivePeriodPacketStore(db=store.db).current_period_head(
            connection,
            user_id=job["user_id"],
            packet_id=period_origin["packet_id"],
            revision=period_origin["revision"],
        )
        frozen = store._checkpoint(row)
        DrivePeriodPacketStore.validate_origin(head, frozen)
        if str(row["period_packet_id"]) != period_origin["packet_id"] or any(
            frozen.get(key) != job["checkpoint"].get(key)
            for key in (
                "query_source",
                "period_packet_origin",
                "semantic_plan",
                "semantic_plan_digest",
                "queries",
                "requested_period",
                "semantic_model_binding",
                "discovery_delivery_policy",
            )
        ):
            raise DriveReadError("search_superseded")


def require_request_semantics(store, job, row, private, evidence_manifest):
    from hushh_mcp.services.drive_owner_allowed import semantic_search_request
    from hushh_mcp.services.drive_owner_search_store import _semantic_binding_current
    from hushh_mcp.services.drive_request_semantic_plan import (
        parse_semantic_plan,
        semantic_plan_digest,
    )

    claimed = job["checkpoint"]
    frozen = store._checkpoint(row)
    semantic = claimed.get("semantic_plan")
    _semantic_binding_current(claimed)
    if claimed.get("provider_packet") is True:
        from hushh_mcp.services.drive_period_packet_page import (
            validate_buyer_checkpoint,
        )

        validate_buyer_checkpoint(evidence_manifest, private, claimed, frozen)
    else:
        from hushh_mcp.services.drive_request_discovery import (
            DISCOVERY_ACTIVITY_UNION_POLICY,
            DISCOVERY_DELIVERY_POLICY,
            DISCOVERY_PROVIDER_RESULTS_POLICY,
        )

        version = private.get("semantic_search_policy_version")
        expected = {
            1: None,
            2: DISCOVERY_DELIVERY_POLICY,
            3: DISCOVERY_PROVIDER_RESULTS_POLICY,
            4: DISCOVERY_ACTIVITY_UNION_POLICY,
        }
        if claimed.get("discovery_delivery_policy") != expected.get(version):
            raise DriveReadError("search_superseded")
        if version == 4 and (
            semantic is None
            or semantic.get("version") != 2
            or claimed.get("semantic_model_binding") is None
        ):
            raise DriveReadError("search_superseded")
        if version in {1, 2, 3} and (semantic is None or semantic.get("version") != 1):
            raise DriveReadError("search_superseded")
        if semantic_search_request(private) != (semantic is not None):
            raise DriveReadError("search_superseded")
        if semantic is not None:
            try:
                parsed = parse_semantic_plan(semantic)
                valid = (
                    parsed.status == "ready"
                    and semantic_plan_digest(parsed) == claimed.get("semantic_plan_digest")
                    and claimed.get("semantic_purpose") == private.get("purpose")
                    and claimed.get("semantic_model_binding")
                    == private.get("semantic_model_binding")
                    and all(
                        claimed.get(key) == frozen.get(key)
                        for key in (
                            "semantic_plan",
                            "semantic_plan_digest",
                            "semantic_purpose",
                            "semantic_assessment_policy",
                            "semantic_model_binding",
                            "discovery_delivery_policy",
                            "queries",
                            "requested_period",
                        )
                    )
                )
            except ValueError:
                valid = False
            if not valid:
                raise DriveReadError("search_superseded")
