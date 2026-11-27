# SPDX-License-Identifier: GPL-3.0-only
"""Stable request-scoped facade for the pinned GPL/MIT Gmail execution helpers.

The caller retains OAuth, review and resource lifetime authority. See
vendor/PROVENANCE.md; this port is not an Apache-2.0-only implementation.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from .execution_types import (
    _MAX_ATTACHMENT_BYTES,
    AccessCheck,
)
from .execution_types import (
    GmailExecutionError as GmailExecutionError,
)
from .gmail_effects import GmailEffectOperations
from .gmail_reads import GmailReadOperations
from .mime_projection import (
    _message_fields as _message_fields,
)
from .mime_projection import (
    _project_message as _project_message_impl,
)
from .vendor.agents_from_scratch.mime import extract_message_part
from .vendor.eaia.execution import create_message
from .vendor.theposch.execution import GmailService


class GmailExecution(GmailReadOperations, GmailEffectOperations):
    """One injected resource and unchanged public execution port, with no retries."""

    def __init__(self, service: Any, *, require_access: AccessCheck | None = None):
        self._service = service
        self._donor = GmailService(service)
        self._require_access = require_access
        # httplib2 resources are not thread-safe. One batch/execute at a time.
        self._lock = asyncio.Lock()

    async def _access(self):
        if self._require_access is not None:
            result = self._require_access()
            if inspect.isawaitable(result):
                await result

    async def _call(self, operation: Callable[[], Awaitable[Any]], *, mutation=False):
        async with self._lock:
            await self._access()
            try:
                # The resource belongs to the caller, which closes it as soon
                # as this method exits. Cancelling to_thread does not stop SDK
                # HTTP, so retain/join this task before releasing that resource.
                # The injecting transport must set its bounded HTTP timeout.
                worker = asyncio.create_task(operation())
                try:
                    result = await asyncio.shield(worker)
                except asyncio.CancelledError as cancelled:
                    while not worker.done():
                        try:
                            await asyncio.shield(worker)
                        except asyncio.CancelledError:
                            # Repeated stop/deadline requests cannot detach the
                            # same owned SDK worker from resource teardown.
                            continue
                        except Exception:
                            break
                    if not worker.cancelled():
                        worker.exception()  # Retrieve failures; cancellation wins.
                    raise cancelled
            except GmailExecutionError:
                raise
            except PermissionError:
                raise GmailExecutionError("permission_denied") from None
            except Exception as exc:
                status = getattr(getattr(exc, "resp", None), "status", None)
                code = {
                    400: "invalid_argument",
                    401: "reconnect_required",
                    403: "permission_denied",
                    404: "not_found",
                    429: "provider_unavailable",
                }.get(status, "provider_unavailable")
                raise GmailExecutionError(
                    code, outcome_unknown=mutation and status not in {400, 401, 403, 404, 429}
                ) from None
            try:
                await self._access()
            except Exception:
                # A post-dispatch authority change must fail closed without
                # making a possibly completed provider effect appear unattempted.
                raise GmailExecutionError("permission_denied", outcome_unknown=mutation) from None
            return result

    @property
    def _attachment_limit(self):
        return _MAX_ATTACHMENT_BYTES

    @staticmethod
    def _project_message(value, *, include_body):
        return _project_message_impl(
            value, include_body=include_body, decode_part=extract_message_part
        )

    @staticmethod
    def _create_reply_message(*args, **kwargs):
        return create_message(*args, **kwargs)
