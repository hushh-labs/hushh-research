"""Company service-key REST adapter. No browser, personal OAuth or arbitrary calls."""

from __future__ import annotations

import json
import time
from urllib.parse import quote

import httpx

from hushh_mcp.services.hubspot_company_contract import (
    CONTACT_PROPERTIES,
    email_fingerprint,
    note_marker,
)


class CompanyCrmError(RuntimeError):
    def __init__(self, code: str, *, uncertain: bool = False):
        super().__init__(code)
        self.uncertain = uncertain


def _crm_id(value) -> str:
    identifier = str(value or "")
    if not identifier.isascii() or not identifier.isdigit() or len(identifier) > 64:
        raise CompanyCrmError("company_receipt_invalid", uncertain=True)
    return identifier


class HubSpotCompanyClient:
    def __init__(self, token: str, portal_id: str, *, client=None):
        if not token or not portal_id.isdigit():
            raise CompanyCrmError("company_configuration_missing")
        self.portal_id = portal_id
        self.http = client or httpx.Client(
            base_url="https://api.hubapi.com",
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(8, connect=4),
            follow_redirects=False,
        )
        self.verified = False
        self.mapping_ready = False
        self.available_fields: set[str] | None = None
        self.deadline: float | None = None

    def close(self):
        self.http.close()

    def _request(self, method: str, path: str, *, missing=False, read_only=False, **kwargs):
        mutating = method != "GET" and not read_only
        remaining = 5.0 if self.deadline is None else min(5.0, self.deadline - time.monotonic())
        if remaining <= 0:
            raise CompanyCrmError("company_item_deadline")
        try:
            with self.http.stream(
                method, path, timeout=httpx.Timeout(remaining), **kwargs
            ) as response:
                status = response.status_code
                if missing and status == 404:
                    return None
                if status == 429:
                    raise CompanyCrmError("company_rate_limited")
                if not 200 <= status < 300:
                    raise CompanyCrmError(
                        "company_request_rejected", uncertain=mutating and status >= 500
                    )
                if status == 204:
                    return {}
                content = bytearray()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > 1_000_000 or (
                        self.deadline is not None and time.monotonic() >= self.deadline
                    ):
                        raise CompanyCrmError("company_response_limit", uncertain=mutating)
        except httpx.HTTPError:
            raise CompanyCrmError("company_transport_unavailable", uncertain=mutating) from None
        try:
            result = json.loads(content)
            if not isinstance(result, dict):
                raise CompanyCrmError("company_response_invalid", uncertain=mutating)
            return result
        except ValueError:
            raise CompanyCrmError("company_response_invalid", uncertain=mutating) from None

    def verify_portal(self):
        details = self._request("GET", "/account-info/v3/details")
        if str(details.get("portalId") or details.get("hubId")) != self.portal_id:
            raise CompanyCrmError("company_portal_mismatch")
        self.verified = True

    def verify_mapping(self):
        self._require_verified()
        self.mapping_ready = False
        # An interrupted inventory cannot prove which One fields need erasing.
        self.available_fields = None
        available_fields = set()
        valid = True
        for name in CONTACT_PROPERTIES:
            prop = self._request("GET", f"/crm/v3/properties/contacts/{name}", missing=True)
            if prop:
                available_fields.add(name)
            if not prop or (
                prop.get("name") != name
                or prop.get("type") != ("string" if name == "one_user_id" else "datetime")
                or (name == "one_user_id" and prop.get("hasUniqueValue") is not True)
            ):
                valid = False
        self.available_fields = available_fields
        if not valid:
            raise CompanyCrmError("company_mapping_mismatch")
        self.mapping_ready = True

    def verify(self):
        self.verify_portal()
        self.verify_mapping()

    def _require_verified(self):
        if not self.verified:
            raise CompanyCrmError("company_not_verified")

    def contact(self, key: str, *, id_property="one_user_id"):
        self._require_verified()
        fields = (
            CONTACT_PROPERTIES if self.available_fields is None else sorted(self.available_fields)
        )
        return self._request(
            "GET",
            f"/crm/v3/objects/contacts/{quote(key, safe='')}",
            params={
                **({"idProperty": id_property} if id_property else {}),
                "properties": ",".join((*fields, "email")),
            },
            missing=True,
        )

    def ensure_contact(
        self,
        properties: dict[str, str],
        *,
        email: str | None,
        verified_email: bool,
        prepare_create=None,
    ) -> tuple[str, str | None]:
        from hushh_mcp.services.hubspot_company_contacts import ensure_contact

        return ensure_contact(
            self,
            properties,
            email=email,
            verified_email=verified_email,
            prepare_create=prepare_create,
        )

    def find_note(self, item_id: str) -> str | None:
        self._require_verified()
        marker = note_marker(item_id)
        result = self._request(
            "POST",
            "/crm/v3/objects/notes/search",
            read_only=True,
            json={
                "query": marker,
                "properties": ["hs_note_body"],
                "limit": 3,
            },
        )
        rows = [
            r
            for r in result.get("results", [])
            if marker in str(r.get("properties", {}).get("hs_note_body", ""))
        ]
        if len(rows) > 1 or result.get("paging"):
            raise CompanyCrmError("company_note_reconciliation_ambiguous")
        return _crm_id(rows[0]["id"]) if rows else None

    def create_note(self, contact_id: str, timestamp: str, body: str) -> str:
        self._require_verified()
        contact_id = _crm_id(contact_id)
        result = self._request(
            "POST",
            "/crm/v3/objects/notes",
            json={
                "properties": {"hs_timestamp": timestamp, "hs_note_body": body},
                "associations": [
                    {
                        "to": {"id": contact_id},
                        "types": [
                            {"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 202}
                        ],
                    }
                ],
            },
        )
        if not result.get("id"):
            raise CompanyCrmError("company_note_unconfirmed", uncertain=True)
        return _crm_id(result["id"])

    def update_note(self, note_id: str, timestamp: str, body: str):
        self._require_verified()
        self._request(
            "PATCH",
            f"/crm/v3/objects/notes/{_crm_id(note_id)}",
            json={"properties": {"hs_timestamp": timestamp, "hs_note_body": body}},
        )

    def delete_note(self, note_id: str):
        self._require_verified()
        self._request("DELETE", f"/crm/v3/objects/notes/{_crm_id(note_id)}", missing=True)

    def clear_owned_contact(
        self, owner_hash: str, owned_email_hash: str | None, remote_contact_id: str | None = None
    ) -> bool:
        current = (
            self.contact(remote_contact_id, id_property=None)
            if remote_contact_id
            else self.contact(owner_hash)
        )
        if not current:
            return False
        bound = current.get("properties", {}).get("one_user_id")
        if bound and bound != owner_hash:
            raise CompanyCrmError("company_cleanup_identity_conflict")
        if self.available_fields is None:
            raise CompanyCrmError("company_cleanup_schema_unavailable")
        properties = dict.fromkeys(self.available_fields, "")
        email = current.get("properties", {}).get("email")
        if email and owned_email_hash and email_fingerprint(email) == owned_email_hash:
            properties["email"] = ""
        # A shared CRM contact and independently authored fields survive.
        if not properties:
            return True
        self._request(
            "PATCH",
            f"/crm/v3/objects/contacts/{_crm_id(current.get('id'))}",
            json={"properties": properties},
        )
        return True
