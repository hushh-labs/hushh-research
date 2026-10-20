"""Claim-bound invocation authority; never an owner session or action approval.

The sealed schedule freezes scopes. Every access also checks the current trusted
binding and occurrence lease. This port cannot mint a browser bearer or confirm
an effect, and no invocation handle survives its execution scope.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from copy import deepcopy
from typing import TYPE_CHECKING

from hushh_mcp.services.pod_consent_client import ConsentVerdict
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

if TYPE_CHECKING:
    from hushh_mcp.services.pod_scheduled_lease import ScheduledExecutionLease
    from hushh_mcp.services.pod_session_authority import PodSessionAuthority


class ScheduledGrantAuthority:
    def __init__(
        self,
        authority: PodSessionAuthority,
        owner_id: str,
        check: Callable[[], Awaitable[None]],
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.authority, self.owner_id, self.check, self.clock = authority, owner_id, check, clock

    async def binding(self, grant: dict) -> dict:
        await self.check()
        subject_id, version = grant.get("subject_id"), grant.get("version")
        if not isinstance(subject_id, str) or not subject_id or type(version) is not int:
            raise ScheduleRefused("SCHEDULE_GRANT_REFUSED")
        subject = self.authority.store.subject(subject_id)
        trust = subject.trust
        if (
            subject.state != "trusted"
            or trust is None
            or trust.role != "app"
            or trust.version != version
        ):
            raise ScheduleRefused("SCHEDULE_GRANT_REVOKED")
        binding = trust.binding
        # Old sealed schedules predate scope capture and are Files-only.
        scopes = grant.get("scopes", ["pod.act", "files.manage"])
        if (
            not isinstance(scopes, list)
            or not 1 <= len(scopes) <= 32
            or any(not isinstance(s, str) or not s or len(s) > 64 for s in scopes)
            or len(set(scopes)) != len(scopes)
            or "pod.act" not in scopes
            or binding.get("user_id") != self.owner_id
            or binding.get("hushh_id") != self.authority.hushh_id
            or not set(scopes).issubset(binding.get("scopes", []))
            or type(binding.get("expires_at_ms")) is not int
            or binding["expires_at_ms"] <= self.clock() * 1000
        ):
            raise ScheduleRefused("SCHEDULE_GRANT_REFUSED")
        return deepcopy(binding)

    async def check_grant(self, grant: dict) -> int:
        binding = await self.binding(grant)
        return int(binding["expires_at_ms"]) // 1000

    def invocation(self, lease: ScheduledExecutionLease) -> ScheduledInvocationAuthority:
        return ScheduledInvocationAuthority(self, lease)


class ScheduledInvocationAuthority:
    def __init__(self, grants: ScheduledGrantAuthority, lease: ScheduledExecutionLease):
        self.grants, self.lease = grants, lease
        self.owner_id = lease.journal.access.owner_id
        self.pod_id = lease.journal.access.pod_id
        self.deadline_ms = lease.claimed["last_run"]["deadline_at"] * 1000
        self._credential = ""

    @contextmanager
    def bind(self) -> Iterator[str]:
        """Fresh request-secret reference; no credential is persisted in the journal."""
        from hushh_mcp.one_adk.request_secrets import consume_request_secret, store_request_secret

        if self._credential:
            raise ScheduleRefused("SCHEDULE_INVOCATION_ALREADY_BOUND")
        self._credential = "pod-task:" + secrets.token_urlsafe(32)
        reference = store_request_secret(self._credential)
        try:
            yield reference
        finally:
            self._credential = ""
            consume_request_secret(reference)

    async def verify(self, token: str, *, expected_scope: str = "", **_ignored) -> ConsentVerdict:
        if not self._credential or not secrets.compare_digest(token, self._credential):
            return ConsentVerdict(valid=False, available=True, reason="not task authority")
        try:
            await self.lease.check()
            if (
                self.owner_id != self.grants.owner_id
                or self.pod_id != self.grants.authority.hushh_id
            ):
                raise ScheduleRefused("SCHEDULE_OWNER_REFUSED")
            binding = await self.grants.binding(self.lease.claimed["grant"])
            approved = self.lease.claimed["grant"].get("scopes", [])
            if not expected_scope or expected_scope not in approved:
                raise ScheduleRefused("SCHEDULE_SCOPE_REFUSED")
            if expected_scope not in binding.get("scopes", []):
                raise ScheduleRefused("SCHEDULE_SCOPE_REFUSED")
        except ScheduleRefused:
            return ConsentVerdict(valid=False, available=True, reason="task authority refused")
        # Cancellation/closure may land while an authority read is suspended.
        if (
            not self._credential
            or not secrets.compare_digest(token, self._credential)
            or self.deadline_ms <= self.lease.journal.clock() * 1000
        ):
            return ConsentVerdict(valid=False, available=True, reason="task invocation ended")
        return ConsentVerdict(
            valid=True,
            available=True,
            user_id=self.owner_id,
            hushh_id=self.pod_id,
            scope=expected_scope,
            reason="current approved occurrence",
        )

    async def owner_read_admission(self, owner: str, token: str) -> None:
        if (
            owner != self.owner_id
            or not (await self.verify(token, expected_scope="pkm.read")).valid
        ):
            raise PermissionError("Scheduled owner information authority unavailable")
