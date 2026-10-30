"""Keep writer renewal within the existing admitted work lifetime."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.pod_runtime_writer import runtime_writer


async def acquire_runtime_turn(admission: Any, incarnation: str) -> Any:
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeInProgress, TurnPermit, _State

    key = str(incarnation or "unknown").strip() or "unknown"
    writer = runtime_writer()
    if writer is not None:
        log = admission._log()
        if (
            log is None
            or not hasattr(log, "read_role")
            or (await log.read_role(fresh=True)).is_standby
        ):
            raise PodUpgradeInProgress("Private writer authority is unavailable")
        try:
            await writer.hold(log)
        except Exception as exc:
            from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmissionRefused

            raise PodUpgradeAdmissionRefused("Private writer authority is unavailable") from exc
    try:
        async with admission._condition:
            state = admission._states.setdefault(key, _State(incarnation=key))
            await admission._hydrate(state)
            if state.draining:
                raise PodUpgradeInProgress("pod is preparing an approved update")
            state.active += 1
        return TurnPermit(admission, key)
    except BaseException:
        if writer is not None:
            await writer.release()
        raise


async def release_runtime_turn(admission: Any, key: str) -> None:
    async with admission._condition:
        state = admission._states.get(key)
        if state is None:
            return
        state.active = max(0, state.active - 1)
        writer = runtime_writer()
        if writer is not None:
            await writer.release()
        if state.active == 0:
            if state.draining and state.drain_hooks_complete and state.receipt is None:
                state.receipt = await admission._persist_idle(state)
            admission._condition.notify_all()


async def prepare_idle_writer(log: Any) -> None:
    writer = runtime_writer()
    if writer is not None:
        if log is None:
            raise RuntimeError("Private idle handoff requires its sealed log")
        async with writer.lock:
            await writer.ensure(log)
