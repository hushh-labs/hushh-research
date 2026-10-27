"""Fixed company contact identity reconciliation through the verified REST port."""

from __future__ import annotations

from hushh_mcp.services.hubspot_company_client import CompanyCrmError, _crm_id
from hushh_mcp.services.hubspot_company_contract import CONTACT_PROPERTIES, email_fingerprint


def ensure_contact(
    client,
    properties: dict[str, str],
    *,
    email: str | None,
    verified_email: bool,
    prepare_create=None,
) -> tuple[str, str | None]:
    client._require_verified()
    if not client.mapping_ready:
        raise CompanyCrmError("company_mapping_not_ready")
    if set(properties) - set(CONTACT_PROPERTIES) or "one_user_id" not in properties:
        raise CompanyCrmError("company_contact_fields_invalid")
    current = client.contact(properties["one_user_id"])
    if current:
        # A delayed refresh must not move the CRM's last sign-in backwards.
        old = current.get("properties", {}).get("one_last_login_at")
        new = properties.get("one_last_login_at")
        if old and new:
            from datetime import datetime

            try:
                if datetime.fromisoformat(old.replace("Z", "+00:00")) > datetime.fromisoformat(new):
                    properties = {**properties, "one_last_login_at": old}
            except (ValueError, TypeError):
                raise CompanyCrmError("company_login_timestamp_invalid") from None
        contact_id = _crm_id(current.get("id"))
        client._request(
            "PATCH", f"/crm/v3/objects/contacts/{contact_id}", json={"properties": properties}
        )
        return contact_id, None
    # Existing business contacts are bound only through a verified email.
    if email and verified_email:
        current = client.contact(email, id_property="email")
        if current:
            bound = current.get("properties", {}).get("one_user_id")
            if bound and bound != properties["one_user_id"]:
                raise CompanyCrmError("company_contact_identity_conflict")
            contact_id = _crm_id(current.get("id"))
            client._request(
                "PATCH",
                f"/crm/v3/objects/contacts/{contact_id}",
                json={"properties": properties},
            )
            return contact_id, None
    owned_email = email if verified_email else None
    payload = {**properties, **({"email": owned_email} if owned_email else {})}
    if prepare_create:
        prepare_create(email_fingerprint(owned_email) if owned_email else None)
    result = client._request(
        "POST",
        "/crm/v3/objects/contacts/batch/upsert",
        json={
            "inputs": [
                {
                    "idProperty": "one_user_id",
                    "id": properties["one_user_id"],
                    "properties": payload,
                }
            ]
        },
    )
    rows = result.get("results", [])
    if len(rows) != 1 or not rows[0].get("id"):
        raise CompanyCrmError("company_upsert_unconfirmed", uncertain=True)
    # Only a new-contact request writes an email; cleanup checks its fingerprint.
    return _crm_id(rows[0]["id"]), email_fingerprint(owned_email) if owned_email else None
