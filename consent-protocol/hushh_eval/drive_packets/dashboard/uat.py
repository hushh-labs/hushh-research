"""Read-only UAT access for the dashboard's one owner, built on the eval's sources.

``UatReadOnlySource`` already gives one read-only connection through the local
Cloud SQL proxy, GET-only Drive with the owner's stored token, and secrets read
with gcloud into process memory. The dashboard adds the request-sharing key
(to open the owner's request envelopes) and fences the engine with
``queries.install_guards``: every statement must be one plain read that carries
the owner id as a bound parameter, whoever runs it in this process.
"""

from __future__ import annotations

import os
from collections.abc import Callable

from hushh_eval.drive_packets.dashboard.queries import install_guards
from hushh_eval.drive_packets.sources import (
    BACKEND_SERVICE,
    UatReadOnlySource,
    _gcloud,
    describe_service,
    resolve_env,
)

EXTRA_SECRETS = ("DRIVE_SHARING_KEY_V1",)


class DashboardUat(UatReadOnlySource):
    """UatReadOnlySource for the one owner, plus the sharing key and the owner fence."""

    def __init__(self, *, owner_user_id: str, db_port: int, command: Callable[..., str] = _gcloud):
        super().__init__(owner_user_id=owner_user_id, db_port=db_port, command=command)
        try:
            extra = resolve_env(describe_service(BACKEND_SERVICE, command), EXTRA_SECRETS, command)
            if set(EXTRA_SECRETS) - set(extra):
                raise RuntimeError("uat_secret_missing")
            for name in EXTRA_SECRETS:
                os.environ[name] = extra[name]
            install_guards(self.engine, owner_user_id)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        super().close()
        for name in EXTRA_SECRETS:
            os.environ.pop(name, None)
