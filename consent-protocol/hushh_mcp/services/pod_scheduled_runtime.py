"""Compose schedules from the current pod's existing authority and recovery owners."""

from __future__ import annotations

from hushh_mcp.services.pod_scheduled_tasks import ScheduleAccess, ScheduledTasks, ScheduleRefused


def active_scheduled_tasks() -> ScheduledTasks:
    from hushh_mcp.services import pod_owner_cloud
    from hushh_mcp.services.pod_memory_service import _resolve_log
    from hushh_mcp.services.pod_platform import workload_platform
    from hushh_mcp.services.pod_role import require_serving_role
    from hushh_mcp.services.pod_scheduled_authority import ScheduledGrantAuthority
    from hushh_mcp.services.pod_scheduled_delivery import (
        GcpScheduledDelivery,
        ResidentScheduledDelivery,
    )
    from hushh_mcp.services.pod_scheduled_files import ScheduledFileOrganization
    from hushh_mcp.services.pod_scheduled_mail import CAPABILITY, ScheduledMailFollowup
    from hushh_mcp.services.pod_scheduled_one import ScheduledOneTask
    from hushh_mcp.services.pod_session_authority import active_session_authority
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    authority, log = active_session_authority(), _resolve_log()
    if (
        authority is None
        or log is None
        or authority.environment not in {"dev", "development", "uat"}
    ):
        raise ScheduleRefused("SCHEDULE_AUTHORITY_UNAVAILABLE")
    existing = getattr(authority, "scheduled_tasks", None)
    if existing is not None:
        if isinstance(existing.delivery, ResidentScheduledDelivery):
            existing.delivery.ensure_rehydrated(existing)
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
    hosted_ace = getattr(pod_owner_cloud, "hosted_ace_runtime", lambda: False)()
    sandbox = hosted_ace or workload_platform() == "ace"
    resident_delivery = ResidentScheduledDelivery() if sandbox else None
    delivery = (
        resident_delivery if resident_delivery is not None else GcpScheduledDelivery(log._store)
    )

    runtime = ScheduledTasks(
        access=ScheduleAccess(owner, authority.hushh_id, incarnation, check),
        log=log,
        capabilities={
            CAPABILITY: ScheduledMailFollowup(grants, log, check),
            "agent_files.organize_file.v1": ScheduledFileOrganization(check),
            "agent_one.execute_task.v1": ScheduledOneTask(grants, log, check),
        },
        delivery=delivery,
        admission=ADMISSION,
        check_grant=grants.check_grant,
    )
    if resident_delivery is not None:
        resident_delivery.bind_runner(runtime.run)
        resident_delivery.ensure_rehydrated(runtime)
    authority.scheduled_tasks = runtime
    return runtime
