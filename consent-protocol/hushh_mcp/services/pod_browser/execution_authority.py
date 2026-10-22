"""Reviewed public-request policy and sealed dispatch for the first live pilot.

Rules are trusted deployment input, never model or route arguments. Origin
admission alone cannot classify a request as research. This first policy does
not authorize sign-in, uploads, submissions or arbitrary website requests.
"""

from __future__ import annotations

import hashlib
from urllib.parse import urlsplit

from pydantic import Field, model_validator

from .consent import BrowserConsentPort
from .contracts import (
    BrowserAction,
    BrowserBinding,
    BrowserExecutionScope,
    BrowserNetworkPermit,
    BrowserRefused,
    BrowserRequest,
    StrictContract,
)
from .dispatch_journal import BrowserDispatchJournal
from .origin import public_origin
from .public_profile import public_headers

_PUBLIC_NAVIGATION_KEYS = frozenset(
    (key,)
    for key in (
        "Tab",
        "Escape",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
    )
) | {("Shift", "Tab")}


class PublicResearchPolicy(StrictContract):
    # Full reviewed page/search URLs. Static resources need a separately
    # reviewed directory; they cannot carry a query or authentication.
    page_urls: tuple[str, ...] = Field(min_length=1, max_length=128)
    static_prefixes: tuple[str, ...] = Field(default=(), max_length=32)
    interactive_origins: tuple[str, ...] = Field(default=(), max_length=20)

    @property
    def interactive(self) -> bool:
        return bool(self.interactive_origins)

    @property
    def digest(self) -> str:
        import json

        return hashlib.sha256(
            json.dumps(
                self.model_dump(mode="json", exclude={"interactive_origins"})
                if not self.interactive_origins
                else self.model_dump(mode="json"),
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()

    @model_validator(mode="after")
    def validate_destinations(self):
        if len(set(self.interactive_origins)) != len(self.interactive_origins) or any(
            public_origin(origin) != origin for origin in self.interactive_origins
        ):
            raise ValueError("Interactive Browser policy requires exact public origins")
        for url in (*self.page_urls, *self.static_prefixes):
            public_origin(url)
            if len(url) > 4096 or urlsplit(url).fragment:
                raise ValueError("Invalid public Browser policy")
        for prefix in self.static_prefixes:
            parsed = urlsplit(prefix)
            if parsed.query or not parsed.path.endswith("/") or parsed.path == "/":
                raise ValueError("Static Browser rules require a bounded directory")
        return self

    def admits(self, request: BrowserRequest) -> bool:
        if (
            request.method != "GET"
            or request.body
            or not public_headers(request.headers, self.page_urls)
        ):
            return False
        if request.url in self.page_urls:
            return True
        parsed = urlsplit(request.url)
        return (
            not parsed.query
            and not parsed.fragment
            and "%" not in parsed.path
            and "\\" not in parsed.path
            and not any(part in {".", ".."} for part in parsed.path.split("/"))
            and any(request.url.startswith(prefix) for prefix in self.static_prefixes)
        )


class BrowserExecutionAuthority:
    def __init__(
        self,
        binding: BrowserBinding,
        consent: BrowserConsentPort,
        journal: BrowserDispatchJournal,
        policy: PublicResearchPolicy,
    ) -> None:
        self._binding, self._consent, self._journal, self._policy = (
            binding,
            consent,
            journal,
            policy,
        )
        self._authorized_action: str | None = None

    async def check_binding(self, binding: BrowserBinding) -> None:
        if binding != self._binding:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        await self._consent.check_binding(binding)

    async def check_no_pending_dispatch(self, binding: BrowserBinding) -> None:
        await self.check_binding(binding)
        await self._journal.require_settled(binding)

    async def authorize_action(
        self,
        binding: BrowserBinding,
        action: BrowserAction,
        *,
        scope: BrowserExecutionScope | None = None,
    ) -> None:
        await self.check_binding(binding)
        if scope is not None:
            scope.require_action(action, binding)
        if self._policy.interactive and scope is not None:
            if (
                action.operation == "navigate"
                and public_origin(action.url or "") not in self._policy.interactive_origins
            ):
                raise BrowserRefused("BROWSER_DESTINATION_REFUSED")
            if scope.actor != "owner" and action.operation in {"type", "keys"}:
                await self._consent.require(
                    binding,
                    "disclose",
                    {
                        "destination_origins": list(self._policy.interactive_origins),
                        "action": action.model_dump(mode="json"),
                        "scope": scope.model_dump(mode="json"),
                    },
                )
            self._authorized_action = self._commitment(binding, action)
            return
        if action.operation == "navigate" and action.url in self._policy.page_urls:
            return
        if action.operation in {"observe", "hover", "scroll", "resize", "click", "drag"}:
            # These inputs confer no network permission. The independent broker
            # still refuses every unqualified request generated by the page.
            return
        if action.operation == "keys" and action.keys in _PUBLIC_NAVIGATION_KEYS:
            # Keyboard focus/scroll is part of the same public preview. Text,
            # paste, submit and browser shortcuts remain outside this pilot;
            # page key handlers gain no additional broker permission.
            return
        raise BrowserRefused("BROWSER_ACTION_NOT_QUALIFIED")

    def _commitment(self, binding, action):
        return self._journal.commitment(binding, "action", action.model_dump(mode="json"))

    async def journal_dispatch(self, binding, action) -> None:
        commitment = self._commitment(binding, action)
        if commitment == self._authorized_action:
            self._authorized_action = None
            await self.check_binding(binding)
        else:
            await self.authorize_action(binding, action)
        await self._journal.begin(binding, "action", commitment)

    async def settle_dispatch(self, binding, action, *, uncertain: bool) -> None:
        # Settlement records the result even after expiry/revocation.
        if binding != self._binding:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        await self._journal.settle(
            binding, "action", self._commitment(binding, action), uncertain=uncertain
        )


class PublicResearchNetworkAuthority:
    def __init__(self, binding, consent, journal, policy: PublicResearchPolicy) -> None:
        self._binding, self._consent, self._journal, self._policy = (
            binding,
            consent,
            journal,
            policy,
        )

    async def check_binding(self, binding) -> None:
        if binding != self._binding:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        await self._consent.check_binding(binding)

    async def check_no_pending_dispatch(self, binding) -> None:
        await self.check_binding(binding)
        # A navigation's UI receipt is pending while its requests complete.
        await self._journal.require_settled(binding, lane="network")

    async def authorize_request(self, binding, request, commitment) -> BrowserNetworkPermit:
        await self.check_binding(binding)
        if commitment != request.commitment():
            raise BrowserRefused("BROWSER_REQUEST_NOT_QUALIFIED")
        if self._policy.admits(request):
            return BrowserNetworkPermit(effect_receipt_required=False)
        scope = request.scope
        if (
            not self._policy.interactive
            or scope is None
            or public_origin(request.url) not in self._policy.interactive_origins
            or scope.deadline_at > binding.expires_at
        ):
            raise BrowserRefused("BROWSER_REQUEST_NOT_QUALIFIED")
        scope.remaining()
        # HTTP verbs cannot establish whether a website changes records or
        # transmits private information. Only the explicit public read rules
        # above bypass review. Keep credential-bearing paths, queries, headers
        # and bodies inside the exact private commitment, outside review copy.
        await self._consent.require(
            binding,
            "disclose",
            {
                "destination": public_origin(request.url),
                "method": request.method,
                "request_commitment": self._commitment(binding, request, commitment),
                "scope": scope.model_dump(mode="json"),
                "transmitted_bytes": len(request.body),
            },
        )
        return BrowserNetworkPermit(effect_receipt_required=True)

    def _commitment(self, binding, request, commitment):
        return self._journal.commitment(
            binding,
            "network",
            {
                "request": commitment,
                "scope": request.scope.model_dump() if request.scope else None,
            },
        )

    async def journal_dispatch(self, binding, request, commitment) -> None:
        await self.check_binding(binding)
        await self._journal.begin(
            binding, "network", self._commitment(binding, request, commitment)
        )

    async def settle_dispatch(self, binding, request, commitment, *, uncertain) -> None:
        if binding != self._binding:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        await self._journal.settle(
            binding, "network", self._commitment(binding, request, commitment), uncertain=uncertain
        )
