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
    """Thread-local HTTP sessions over an optional shared connection pool.

    Requests Sessions are mutable, so each worker gets its own cookie-disabled
    Session while authorization remains explicit on each request. Sharing one
    thread-safe urllib3 HTTPAdapter across a pod's worker threads avoids
    redundant HTTP CONNECT + TLS handshakes during cold/warm sandbox startup.
    """

    def __init__(self, *, shared_pool: bool = False) -> None:
        self._workers = threading.local()
        self._adapter_lock = threading.Lock()
        self._shared_adapter: Any = None
        self._use_shared_pool = bool(shared_pool)

    def _get_shared_adapter(self) -> Any:
        if self._shared_adapter is not None:
            return self._shared_adapter
        with self._adapter_lock:
            if self._shared_adapter is None:
                from requests.adapters import HTTPAdapter

                proxy_lock = threading.Lock()

                class _ThreadSafePoolAdapter(HTTPAdapter):
                    def proxy_manager_for(self, proxy: Any, **proxy_kwargs: Any) -> Any:
                        with proxy_lock:
                            return super().proxy_manager_for(proxy, **proxy_kwargs)

                self._shared_adapter = _ThreadSafePoolAdapter(
                    pool_connections=8,
                    pool_maxsize=16,
                )
            return self._shared_adapter

    def _session_for_worker(self) -> Any:
        session = getattr(self._workers, "session", None)
        if session is None:
            import requests

            session = requests.Session()
            session.cookies.set_policy(_NoCookies())
            if self._use_shared_pool:
                adapter = self._get_shared_adapter()
                session.mount("https://", adapter)
                session.mount("http://", adapter)
            else:
                weakref.finalize(self, session.close)
            self._workers.session = session
        return session

    def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        import requests

        session = self._session_for_worker()
        try:
            return session.request(method, url, **kwargs)
        except requests.exceptions.ConnectionError as exc:
            if isinstance(exc, requests.exceptions.ConnectTimeout) or method.upper() not in {
                "GET",
                "HEAD",
            }:
                raise
            return session.request(method, url, **kwargs)

    def get(self, url: str, **kwargs: Any) -> Any:
        return self._request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self._request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> Any:
        return self._request("PUT", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> Any:
        return self._request("DELETE", url, **kwargs)


_SHARED_POD_TRANSPORT_LOCK = threading.Lock()
_SHARED_POD_TRANSPORT: PodStorageTransport | None = None


def shared_pod_storage_transport() -> PodStorageTransport:
    """Process-shared cookie-free connection pool for pod Hub and object-store I/O."""
    global _SHARED_POD_TRANSPORT
    if _SHARED_POD_TRANSPORT is not None:
        return _SHARED_POD_TRANSPORT
    with _SHARED_POD_TRANSPORT_LOCK:
        if _SHARED_POD_TRANSPORT is None:
            _SHARED_POD_TRANSPORT = PodStorageTransport(shared_pool=True)
        return _SHARED_POD_TRANSPORT
