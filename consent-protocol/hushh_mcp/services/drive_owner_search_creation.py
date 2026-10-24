"""Canonical search-row creation, called only inside the admitted store transaction."""


def insert_job(
    store,
    connection,
    *,
    user_id,
    identity,
    client,
    digest,
    current,
    checkpoint,
    v1_statement_search,
    period_packet_id,
):
    from hushh_mcp.services.drive_owner_search_store import CONSENT_VERSION

    row = store._row(
        connection,
        """
        INSERT INTO drive_owner_search_jobs(job_id,user_id,client_request_id,request_digest,
          connection_generation,consent_version,checkpoint_envelope,v1_statement_search,period_packet_id)
        VALUES(:job,:user,:client,:digest,:generation,:consent,CAST(:envelope AS jsonb),:v1_statement_search,:period_packet) RETURNING *
    """,
        {
            "job": identity,
            "user": user_id,
            "client": client,
            "digest": digest,
            "generation": current["connection_generation"],
            "consent": CONSENT_VERSION,
            "v1_statement_search": v1_statement_search,
            "period_packet": period_packet_id,
            "envelope": store._seal(checkpoint, user_id, identity, "owner-search-checkpoint"),
        },
    )
    return row
