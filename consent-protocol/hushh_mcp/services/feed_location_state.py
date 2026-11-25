"""Current Location lifecycle facts for Feed; no access or workflow authority."""


def grant_status_sql(alias: str) -> str:
    if alias not in {"flg", "result_grant", "live"}:
        raise ValueError("Authored grant alias required")
    return f"""CASE WHEN to_jsonb({alias})->>'status'='active'
      AND (((to_jsonb({alias})->>'expires_at') IS NULL AND COALESCE(to_jsonb({alias})->>'duration_mode','')<>'until_stopped')
        OR (to_jsonb({alias})->>'expires_at')::timestamptz<=clock_timestamp())
      THEN 'expired' ELSE to_jsonb({alias})->>'status' END"""


def active_incident_sql(alias, columns, uuid_sql):
    if alias not in {"item", "f"}:
        raise ValueError("Authored Feed alias required")
    if not {"id", "recipient_user_id", "status", "metadata"} <= columns.get(
        "one_location_share_grants", set()
    ):
        return "FALSE"
    grant_id = f"COALESCE({uuid_sql(f"{alias}.metadata->>'recorded_grant_id'")},{uuid_sql(f"{alias}.metadata->>'grant_id'")},{uuid_sql(f"split_part({alias}.source_row_id,':',1)")})"
    # Closed source/schema fragments only; values remain in execute_raw parameters.
    return f"""({alias}.source_domain='location' AND EXISTS(
      SELECT 1 FROM one_location_share_grants live WHERE live.id={grant_id}
        AND live.recipient_user_id={alias}.user_id
        AND live.metadata->>'share_kind'='sos' AND ({grant_status_sql("live")})='active'))"""  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
