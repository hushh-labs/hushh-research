"""SQL-only operations on the dedicated hosted Files executor connection."""

from __future__ import annotations

from typing import Any, Callable, cast


def claim_statement(
    *,
    snapshot_params: dict[str, Any],
    owner_id: str,
    target_image: str,
    deployed_image: str,
    operation_id: str,
    plan: dict[str, Any],
    incarnation: str,
    execution_id: str,
    json_dumps: Callable[..., str],
) -> tuple[str, dict[str, Any]]:
    sql = """SELECT public.begin_hosted_files_executor(
            :owner_id, CAST(:observed_registry AS jsonb), CAST(:observed_host_metadata AS jsonb),
            :observed_updated_at, :observed_user_cloud_authorized_at,
            CAST(:observed_backend_metadata AS jsonb), :target_image, :deployed_image, :operation_id,
            CAST(:plan AS jsonb), :incarnation, :execution_id) AS lease"""
    params = {
        **snapshot_params,
        "owner_id": owner_id,
        "target_image": target_image,
        "deployed_image": deployed_image,
        "operation_id": operation_id,
        "plan": json_dumps(plan, separators=(",", ":")),
        "incarnation": incarnation,
        "execution_id": execution_id,
    }
    return sql, params


def resume_statement(
    *,
    snapshot_params: dict[str, Any],
    owner_id: str,
    lease: str,
    retry_checkpoint: dict[str, Any],
    plan: dict[str, Any],
    incarnation: str,
    deployed_image: str,
    execution_id: str,
    json_dumps: Callable[..., str],
) -> tuple[str, dict[str, Any]]:
    sql = """SELECT public.resume_hosted_files_executor(
            :owner_id, CAST(:observed_registry AS jsonb), CAST(:observed_host_metadata AS jsonb),
            :observed_updated_at, :observed_user_cloud_authorized_at,
            CAST(:observed_backend_metadata AS jsonb), :lease, CAST(:retry_checkpoint AS jsonb),
            CAST(:plan AS jsonb), :incarnation, :deployed_image, :execution_id) AS registry_row"""
    params = {
        **snapshot_params,
        "owner_id": owner_id,
        "lease": lease,
        "retry_checkpoint": json_dumps(retry_checkpoint, separators=(",", ":")),
        "plan": json_dumps(plan, separators=(",", ":")),
        "incarnation": incarnation,
        "deployed_image": deployed_image,
        "execution_id": execution_id,
    }
    return sql, params


def claim_lease(
    connection: Any,
    *,
    sql: str,
    params: dict[str, Any],
    sql_text: Callable[[str], Any],
) -> str | None:
    with connection.begin():
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        result = connection.execute(sql_text(sql), params)
        row = result.mappings().one()
        lease = row.get("lease")
    return cast(str | None, lease)


def resume_claim(
    connection: Any,
    *,
    sql: str,
    params: dict[str, Any],
    sql_text: Callable[[str], Any],
) -> dict | None:
    with connection.begin():
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        result = connection.execute(sql_text(sql), params)
        row = result.mappings().one()
        registry_row = row.get("registry_row")
    return cast(dict | None, registry_row)


def confirm_claim(
    connection: Any,
    *,
    sql: str,
    params: dict[str, Any],
    sql_text: Callable[[str], Any],
) -> str | None:
    with connection.begin():
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        result = connection.execute(sql_text(sql), params)
        row = result.mappings().one()
        return cast(str | None, row.get("lease"))


def session_identity(connection: Any, *, sql_text: Callable[[str], Any]) -> dict[str, Any]:
    with connection.begin():
        result = connection.execute(
            sql_text(
                "SELECT pg_backend_pid() AS pid, backend_start "
                "FROM pg_stat_activity WHERE pid=pg_backend_pid()"
            )
        )
        return dict(result.mappings().one())


def session_lock_held(
    connection: Any,
    *,
    owner_id: str,
    witness: dict[str, Any],
    sql_text: Callable[[str], Any],
    json_dumps: Callable[..., str],
) -> bool:
    with connection.begin():
        result = connection.execute(
            sql_text(
                "SELECT public.hosted_files_executor_session_held("
                ":owner_id, CAST(:witness AS jsonb))"
            ),
            {"owner_id": owner_id, "witness": json_dumps(witness)},
        )
        return result.scalar_one() is True


def record_replacement_intent(
    connection: Any,
    *,
    owner_id: str,
    execution_id: str,
    lease: str,
    operation_id: str,
    predecessor: dict[str, Any],
    sql_text: Callable[[str], Any],
    json_dumps: Callable[..., str],
) -> bool:
    sql = """SELECT public.record_hosted_files_replacement_intent(
            :owner_id, :execution_id, :lease, :operation_id, CAST(:predecessor AS jsonb)) AS retained"""
    with connection.begin():
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        result = connection.execute(
            sql_text(sql),
            {
                "owner_id": owner_id,
                "execution_id": execution_id,
                "lease": lease,
                "operation_id": operation_id,
                "predecessor": json_dumps(predecessor, separators=(",", ":")),
            },
        )
        return result.scalar_one() is True


def record_provider_settlement(
    connection: Any,
    *,
    owner_id: str,
    execution_id: str,
    lease: str,
    receipt: dict[str, Any],
    sql_text: Callable[[str], Any],
    json_dumps: Callable[..., str],
) -> bool:
    sql = """SELECT public.record_hosted_files_provider_settlement(
            :owner_id, :execution_id, :lease, CAST(:receipt AS jsonb)) AS retained"""
    with connection.begin():
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        result = connection.execute(
            sql_text(sql),
            {
                "owner_id": owner_id,
                "execution_id": execution_id,
                "lease": lease,
                "receipt": json_dumps(receipt, separators=(",", ":")),
            },
        )
        return result.scalar_one() is True


def finish_executor(
    connection: Any,
    *,
    owner_id: str,
    execution_id: str,
    lease: str,
    sql_text: Callable[[str], Any],
) -> bool:
    sql = """SELECT public.finish_hosted_files_executor(
            :owner_id, :execution_id, :lease) AS retained"""
    with connection.begin():
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        result = connection.execute(
            sql_text(sql),
            {"owner_id": owner_id, "execution_id": execution_id, "lease": lease},
        )
        return result.scalar_one() is True
