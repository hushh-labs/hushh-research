"""Call-recording Location port for the One Voice contract tests."""

from typing import Any


class FakeLocationService:
    """Records every call; returns canned payloads shaped like the real service."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.errors: dict[str, Exception] = {}
        self.results: dict[str, Any] = {}

    def _call(self, name: str, **kwargs: Any) -> Any:
        self.calls.append((name, kwargs))
        if name in self.errors:
            raise self.errors[name]
        return self.results.get(name)

    def called(self, name: str) -> dict[str, Any] | None:
        for called, kwargs in self.calls:
            if called == name:
                return kwargs
        return None

    def list_pending_requester_requests(self, **kwargs: Any) -> Any:
        return self._call("list_pending_requester_requests", **kwargs) or []

    def request_access(self, **kwargs: Any) -> Any:
        return self._call("request_access", **kwargs)

    def list_state(self, **kwargs: Any) -> Any:
        return self._call("list_state", **kwargs) or {}

    def approve_request(self, **kwargs: Any) -> Any:
        return self._call("approve_request", **kwargs)

    def deny_request(self, **kwargs: Any) -> Any:
        return self._call("deny_request", **kwargs)

    def withdraw_request(self, **kwargs: Any) -> Any:
        return self._call("withdraw_request", **kwargs)

    def list_verified_recipients(self, **kwargs: Any) -> Any:
        return self._call("list_verified_recipients", **kwargs) or []

    def create_grant(self, **kwargs: Any) -> Any:
        return self._call("create_grant", **kwargs)

    def revoke_grant(self, **kwargs: Any) -> Any:
        return self._call("revoke_grant", **kwargs)

    def set_grant_duration(self, **kwargs: Any) -> Any:
        return self._call("set_grant_duration", **kwargs)

    def create_public_invite(self, **kwargs: Any) -> Any:
        return self._call("create_public_invite", **kwargs)

    def revoke_public_invite(self, **kwargs: Any) -> Any:
        return self._call("revoke_public_invite", **kwargs)
