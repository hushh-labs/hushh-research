"""Typed failures for the enterprise SSO operon. Codes are stable API strings."""

from __future__ import annotations


class EnterpriseSsoError(Exception):
    """A refusal the route turns into a fixed, non-revealing HTTP response."""

    def __init__(self, code: str, status_code: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
