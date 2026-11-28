"""Compare-and-set for client-encrypted Mail information in the owner log."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.services.pod_commit_log import PodLogConflict

_KIND = "mail_private_state_v1"


async def latest_mail_state(log: Any, scope: list[str]) -> tuple[dict[str, Any] | None, int]:
    records = await log.replay()
    for record in reversed(records):
        payload = record["payload"]
        if record["kind"] == _KIND and payload["scope"] == scope:
            return {"revision": payload["revision"], "sealed": payload["sealed"]}, records[-1][
                "seq"
            ]
    return None, records[-1]["seq"] if records else 0


async def save_mail_state(
    log: Any,
    scope: list[str],
    expected_revision: int,
    sealed: dict[str, str],
    require_current: Callable[[], Awaitable[None]],
) -> int:
    for _ in range(3):
        current, head = await latest_mail_state(log, scope)
        revision = current["revision"] if current else 0
        if revision != expected_revision:
            raise PodLogConflict("Mail information advanced.")
        await require_current()
        try:
            await log.append(
                _KIND,
                {"scope": scope, "revision": revision + 1, "sealed": sealed},
                expected_seq=head,
            )
            return revision + 1
        except PodLogConflict:
            # Other kinds of records can advance the same owner log.
            continue
    raise PodLogConflict("The private storage head advanced.")
