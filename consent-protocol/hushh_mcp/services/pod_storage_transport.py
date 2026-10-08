"""Reuse storage connections within one store and worker, never owner credentials."""

from __future__ import annotations

import threading
import weakref
from http.cookiejar import DefaultCookiePolicy
from typing import Any


class _NoCookies(DefaultCookiePolicy):
    def set_ok(self, cookie, request) -> bool:
        return False

    def return_ok(self, cookie, request) -> bool:
        return False


class PodStorageTransport:
    """Thread-local HTTP pools; authorization remains explicit on each request.

    Requests Sessions are mutable, so each worker gets its own. No response or
    information cache is introduced. Collection of this store closes its pools.
    """

    def __init__(self) -> None:
        self._workers = threading.local()

    def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        session = getattr(self._workers, "session", None)
        if session is None:
            import requests

            session = requests.Session()
            session.cookies.set_policy(_NoCookies())
            self._workers.session = session
            weakref.finalize(self, session.close)
        return session.request(method, url, **kwargs)

    def get(self, url: str, **kwargs: Any) -> Any:
        return self._request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self._request("POST", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> Any:
        return self._request("DELETE", url, **kwargs)
