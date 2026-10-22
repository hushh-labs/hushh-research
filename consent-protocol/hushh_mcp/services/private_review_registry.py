"""Registry transaction shared by private action-ledger coordination.

Caller authentication and exact action terms remain with the route and action
owner. Holding the registry lock prevents an old deployment consuming approval
while a placement change commits. This helper never confirms on a pod's behalf.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.pod_hub_client import VerifiedOwnerPod
from hushh_mcp.services.pod_request_signing import VerifiedPod

T = TypeVar("T")


def principal_holds_private_row(principal: object, hushh_id: str, row: dict) -> bool:
    if (
        not isinstance(principal, (VerifiedPod, VerifiedOwnerPod))
        or principal.hushh_id != hushh_id
        or getattr(principal, "standby", False)
    ):
        return False
    key_id = getattr(principal, "key_id", None)
    if key_id:
        return row.get("hushh_id") == hushh_id and row.get("pod_signing_key_id") == key_id
    metadata = row.get("backend_metadata") or {}
    return bool(principal.service_account) and principal.service_account == metadata.get(
        "runtime_service_account"
    )


async def with_private_review_registry(
    *,
    owner_id: str,
    hushh_id: str,
    pod_key_id: str,
    environment: str,
    service_uid: str | None,
    issuing: bool,
    owner_confirmation: bool,
    principal: VerifiedPod | VerifiedOwnerPod | None,
    apply: Callable[[ActionDirectiveStore, str], Coroutine[Any, Any, T]],
    db=None,
) -> T:
    from sqlalchemy import text

    from db.db_client import get_db
    from hushh_mcp.services.personal_agent_direct_admission import direct_owner_matches
    from hushh_mcp.services.pod_binding_service import hub_environment

    database = db if db is not None else get_db()
    signed = not owner_confirmation and bool(getattr(principal, "key_id", None))
    query = (
        "SELECT hushh_id,status,deployment_target,pod_key_id,pod_pubkey,backend_metadata,"
        "pod_signing_key_id FROM personal_agent_registry WHERE user_id=:owner FOR UPDATE"
        if signed
        else "SELECT hushh_id,status,deployment_target,pod_key_id,pod_pubkey,backend_metadata "
        "FROM personal_agent_registry WHERE user_id=:owner FOR UPDATE"
    )

    def commit() -> T:
        with database.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout = '5s'"))
            conn.execute(text("SET LOCAL lock_timeout = '2s'"))
            row = (
                conn.execute(
                    text(query),
                    {"owner": owner_id},
                )
                .mappings()
                .one_or_none()
            )
            metadata = (row or {}).get("backend_metadata") or {}
            if not owner_confirmation and not principal_holds_private_row(
                principal, hushh_id, dict(row or {})
            ):
                raise ActionDirectiveAuthorityError("Private runtime identity changed.")
            uid = metadata.get("serviceUid")
            url = str(metadata.get("url") or "").strip().rstrip("/")
            if (
                not uid
                or environment != hub_environment()
                or not direct_owner_matches(
                    row,
                    hushh_id=hushh_id,
                    pod_key_id=pod_key_id,
                    pod_public_key=(row or {}).get("pod_pubkey"),
                    service_uid=uid,
                    url=url,
                )
                or (not issuing and service_uid != uid)
                or (service_uid is not None and service_uid != uid)
            ):
                raise ActionDirectiveAuthorityError("Private assignment changed.")
            return asyncio.run(apply(ActionDirectiveStore(connection=conn), uid))

    return await asyncio.to_thread(commit)
