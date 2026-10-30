"""Reuse the canonical One credential source; only short-lived send authority exits."""

from __future__ import annotations

import asyncio
import threading

from google.auth.transport.requests import Request
from google.oauth2 import service_account


class OneSenderTokenProvider:
    def __init__(self):
        from hushh_mcp.services.support_email_service import SupportEmailConfig

        config = SupportEmailConfig.from_env()
        # Do not inherit support test recipients, BCC, mode, From or templates.
        self.credentials = service_account.Credentials.from_service_account_info(
            config.service_account_info,
            scopes=["https://www.googleapis.com/auth/gmail.send"],
            subject="one@hushh.ai",
        )
        self.lock = threading.Lock()

    def _get(self) -> str:
        with self.lock:
            if not self.credentials.valid:
                request = Request()

                def bounded_request(**kwargs):
                    kwargs["timeout"] = 8
                    return request(**kwargs)

                self.credentials.refresh(bounded_request)
            if not self.credentials.token:
                raise RuntimeError("One sender is unavailable.")
            return self.credentials.token

    async def get(self) -> str:
        return await asyncio.to_thread(self._get)
