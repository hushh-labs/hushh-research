"""A managed request rechecks current operation authority before every API call."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any, NoReturn, cast

from hushh_mcp.services.gcp_run_client import GcpRunClient


class AdmittedRunClient(GcpRunClient):
    def __init__(self, *, guard: Callable[[], None], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._guard = guard
        self._replacement = threading.local()

    def _headers(self) -> dict[str, str]:
        if getattr(self._replacement, "files", False):
            work_check = getattr(self._guard, "require_files_work", None)
            if not callable(work_check):
                raise RuntimeError("Files mutation authority is unavailable")
            work_check()
        else:
            self._guard()
        return cast(dict[str, str], super()._headers())

    def replace_service(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        # A Files update remains subject to its erasure gate through the
        # service replacement, while ordinary inspection stays read-only.
        previous = getattr(self._replacement, "files", False)
        self._replacement.files = getattr(self._guard, "files_work_check", None) is not None
        try:
            return cast(dict[str, Any], super().replace_service(*args, **kwargs))
        finally:
            self._replacement.files = previous


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
