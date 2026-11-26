"""One selected login POST and its host-observed same-origin GET redirects.

This authority comes from a freshly checked owner credential policy, never a
page instruction, HTTP verb heuristic, model approval or generic write grant.
The existing Browser network journal still records every effect before IO.
"""

from __future__ import annotations

import hashlib
from urllib.parse import urljoin

from .contracts import BrowserRefused
from .origin import public_origin


class CredentialSubmission:
    def __init__(self, binding, descriptor, request, scope, target, check):
        if (
            not isinstance(target, dict)
            or set(target) != {"action_url", "encoding"}
            or public_origin(target["action_url"]) != request.origin
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_TARGET_REFUSED")
        self.binding, self.scope, self.origin, self.check = binding, scope, request.origin, check
        self.operation_id, self.target = request.operation_id, target
        self.terms = {
            "purpose": "website_authentication",
            "credential": descriptor.model_dump(mode="json"),
            "operation_id": request.operation_id,
            "scope": scope.model_dump(mode="json"),
            "target": target,
        }
        self._used = False
        self._root_confirmed = False
        self._redirects = {}
        self._admitted = set()

    async def authorize(self, request, proof):
        if proof is None:
            return False
        if (
            request.scope != self.scope
            or public_origin(request.url) != self.origin
            or not isinstance(proof, dict)
            or proof.get("operation_id") != self.operation_id
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_REQUEST_REFUSED")
        await self.check()
        if proof.get("kind") == "submit":
            if self._used:
                raise BrowserRefused("BROWSER_ACTION_REPLAY")
            if (
                set(proof) != {"kind", "operation_id", "request_id", "body_sha256", "action_url"}
                or self.target["encoding"] != "application/x-www-form-urlencoded"
                or request.method != "POST"
                or request.url != self.target["action_url"]
                or proof["action_url"] != request.url
                or hashlib.sha256(request.body).hexdigest() != proof["body_sha256"]
                or not any(
                    name.lower() == "content-type"
                    and value.split(";", 1)[0].strip().lower() == self.target["encoding"]
                    for name, value in request.headers
                )
            ):
                raise BrowserRefused("BROWSER_CREDENTIAL_REQUEST_REFUSED")
            self._used = True
        elif proof.get("kind") == "redirect":
            if (
                set(proof) != {"kind", "operation_id", "request_id", "parent_request_id"}
                or request.method != "GET"
                or request.body
                or self._redirects.pop(proof["parent_request_id"], None) != request.url
            ):
                raise BrowserRefused("BROWSER_CREDENTIAL_REQUEST_REFUSED")
        else:
            raise BrowserRefused("BROWSER_CREDENTIAL_REQUEST_REFUSED")
        identifier = proof.get("request_id")
        if (
            not isinstance(identifier, str)
            or not 1 <= len(identifier) <= 128
            or identifier in self._admitted
            or len(self._admitted) >= 8
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_REQUEST_REFUSED")
        self._admitted.add(identifier)
        return True

    @property
    def completed(self):
        return self._root_confirmed and not self._redirects

    def response(self, request, proof, response):
        if (
            proof is not None
            and proof.get("request_id") in self._admitted
            and proof.get("kind") == "submit"
        ):
            self._root_confirmed = True
        if (
            proof is None
            or proof.get("request_id") not in self._admitted
            or response.status not in {301, 302, 303}
        ):
            return
        locations = [value for name, value in response.headers if name.lower() == "location"]
        if len(locations) == 1:
            destination = urljoin(request.url, locations[0])
            if public_origin(destination) == self.origin:
                self._redirects[proof["request_id"]] = destination
