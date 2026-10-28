"""A managed request rechecks current operation authority before every API call."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, NoReturn, cast

from hushh_mcp.services.gcp_run_client import GcpRunClient


class AdmittedRunClient(GcpRunClient):
    def __init__(self, *, guard: Callable[[], None], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._guard = guard

    def _headers(self) -> dict[str, str]:
        self._guard()
        return cast(dict[str, str], super()._headers())


def private_run_client(
    project: str, region: str, credentials: Any, guard: Callable[[], None] | None
) -> GcpRunClient:
    if guard is None:
        return GcpRunClient(project=project, region=region, credentials=credentials)
    client_type = (
        InspectionRunClient if getattr(guard, "operation", None) == "inspect" else AdmittedRunClient
    )
    return client_type(project=project, region=region, credentials=credentials, guard=guard)


class InspectionRunClient(AdmittedRunClient):
    def _refuse_mutation(self, *args: Any, **kwargs: Any) -> NoReturn:
        raise RuntimeError("Update recovery permits read-only provider observation")

    create_service = replace_service = delete_service = _refuse_mutation
    set_invoker_binding = grant_public_invoker = _refuse_mutation
