"""Compose schedules from the current pod's existing authority and recovery owners."""

from __future__ import annotations

from hushh_mcp.services.pod_scheduled_tasks import ScheduleAccess, ScheduledTasks, ScheduleRefused


def active_scheduled_tasks() -> ScheduledTasks:
    from hushh_mcp.services.pod_memory_service import _resolve_log
    from hushh_mcp.services.pod_role import require_serving_role
    from hushh_mcp.services.pod_scheduled_authority import ScheduledGrantAuthority
    from hushh_mcp.services.pod_scheduled_delivery import GcpScheduledDelivery
    from hushh_mcp.services.pod_scheduled_files import ScheduledFileOrganization
    from hushh_mcp.services.pod_session_authority import active_session_authority
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    authority, log = active_session_authority(), _resolve_log()
    if authority is None or log is None or authority.environment not in {"dev", "development"}:
        raise ScheduleRefused("SCHEDULE_AUTHORITY_UNAVAILABLE")
    existing = getattr(authority, "scheduled_tasks", None)
    if existing is not None:
        return existing
    owners = {
        r.binding.get("user_id") for r in authority.store.trusted_subjects() if r.role == "app"
    }
    if len(owners) != 1 or not all(isinstance(owner, str) and owner for owner in owners):
        raise ScheduleRefused("SCHEDULE_OWNER_UNAVAILABLE")
    owner = owners.pop()
    incarnation = pod_incarnation()

    async def check():
        if active_session_authority() is not authority or pod_incarnation() != incarnation:
            raise ScheduleRefused("SCHEDULE_AUTHORITY_CHANGED")
        await require_serving_role()
        await authority.require_held()

    grants = ScheduledGrantAuthority(authority, owner, check)

    runtime = ScheduledTasks(
        access=ScheduleAccess(owner, authority.hushh_id, incarnation, check),
        log=log,
        capabilities={"agent_files.organize_file.v1": ScheduledFileOrganization(check)},
        delivery=GcpScheduledDelivery(log._store),
        admission=ADMISSION,
        check_grant=grants.check_grant,
    )
    authority.scheduled_tasks = runtime
    return runtime
