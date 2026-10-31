"""Chain-verified, read-only inventory behind the existing erasure fence."""

from __future__ import annotations

import base64
import json
from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.services.pod_log_replay import replay_chain


def read_erasure_fence(
    raw: bytes,
    *,
    unseal: Callable[[bytes], dict[str, Any]],
    valid_identity: Callable[[Any], bool],
    configured_owner: str | None,
    read_head: Callable[[bytes], dict[str, Any] | None],
    canonical: Callable[[Any], bytes],
) -> dict[str, Any] | None:
    from hushh_mcp.services.pod_commit_log import PodLogTampered

    try:
        envelope = json.loads(raw)
        if not isinstance(envelope, dict) or "sealedFence" not in envelope:
            return None
        if (
            set(envelope) != {"version", "state", "seq", "sealedFence"}
            or type(envelope["version"]) is not int
            or envelope["version"] != 2
            or envelope["state"] != "fenced"
            or envelope["seq"] != "fenced"
        ):
            raise ValueError("shape")
        fence = unseal(base64.b64decode(envelope["sealedFence"], validate=True))
        if (
            not isinstance(fence, dict)
            or set(fence) != {"kind", "owner_id", "attempt_id", "prior_head"}
            or fence["kind"] != "pod_log_erasure_fence"
            or not valid_identity(fence["owner_id"])
            or not valid_identity(fence["attempt_id"])
            or (configured_owner is not None and fence["owner_id"] != configured_owner)
        ):
            raise ValueError("binding")
        prior = fence["prior_head"]
        if prior is not None:
            if not isinstance(prior, dict) or set(prior) != {"seq", "key", "sha"}:
                raise ValueError("predecessor")
            read_head(canonical(prior))
        return fence
    except Exception:  # noqa: BLE001 - encrypted lifecycle metadata stays private
        raise PodLogTampered("the log erasure fence did not verify") from None


async def verified_erasure_fence(
    *,
    owner_id: str,
    configured_owner: str | None,
    attempt_id: str,
    read_head: Callable[[], Awaitable[tuple[bytes | None, Any]]],
    read_fence: Callable[[bytes], dict[str, Any] | None],
    valid_identity: Callable[[Any], bool],
) -> dict[str, Any]:
    from hushh_mcp.services.pod_commit_log import PodLogFenced

    if (
        not valid_identity(owner_id)
        or owner_id != configured_owner
        or not valid_identity(attempt_id)
    ):
        raise PodLogFenced("log erasure authority unavailable")
    raw, _ = await read_head()
    fence = read_fence(raw) if raw is not None else None
    if fence is None or fence["attempt_id"] != attempt_id:
        raise PodLogFenced("log erasure fence does not match")
    return fence


async def inventory_fenced_log(
    *,
    verified_fence: Callable[[], Awaitable[dict[str, Any]]],
    read_record: Callable[[str], Awaitable[bytes | None]],
    unseal: Callable[[bytes], dict[str, Any]],
    record_sha: Callable[[dict[str, Any]], str],
    visit_reverse: Callable[[dict[str, Any]], None],
) -> list[str]:
    from hushh_mcp.services.pod_commit_log import PodLogFenced

    prior = (await verified_fence())["prior_head"]
    keys = [prior["key"]] if prior else []

    def collect(record: dict[str, Any]) -> None:
        if record.get("prev_key"):
            keys.append(record["prev_key"])
        visit_reverse(record)

    await replay_chain(
        prior, read_record=read_record, unseal=unseal, record_sha=record_sha, visit_reverse=collect
    )
    if prior != (await verified_fence())["prior_head"]:
        raise PodLogFenced("log erasure fence changed during inventory")
    return keys
