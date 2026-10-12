"""Server-derived, encrypted Wallet projection; never a client-authored authority."""

import json
import os

from hushh_mcp.services.direct_messages_service import DirectMessageCipher, DirectMessagesError
from hushh_mcp.services.user_identifier_service import normalize_country_hint
from hushh_mcp.services.wallet_card_validation import (
    validate_card_summary_entry,
    validate_wallet_card_envelope,
)

PROJECTION_KEY = "wallet_card_access_projection"


class WalletCardSourceCipher(DirectMessageCipher):
    @staticmethod
    def _aad(*, conversation_id, message_id, sender_user_id):
        return json.dumps(
            ["wallet-card-source-v1", sender_user_id, message_id], separators=(",", ":")
        ).encode()


def masked_card_projection(entry):
    validate_card_summary_entry(entry)
    return {
        "brand": str(entry["brand"]).strip().lower(),
        "last4": f"{int(entry['last4']):04d}",
        "expiryMonth": int(entry["expiry_month"]),
        "expiryYear": int(entry["expiry_year"]),
        "issuingRegion": normalize_country_hint(entry.get("issuing_region", "")) or "",
    }


def wallet_source_records(summary):
    validate_wallet_card_envelope(summary)
    return [
        {"cardId": entry["card_id"], **masked_card_projection(entry)}
        for entry in sorted(summary.get("cards") or [], key=lambda item: item["card_id"])
    ]


def seal_wallet_source(owner, records):
    projection = {"version": 1, "cardIds": [entry["cardId"] for entry in records], "cards": []}
    if os.getenv("WALLET_CARD_ACCESS_ENABLED", "").lower() not in {"1", "true", "yes"}:
        return projection
    cipher = WalletCardSourceCipher()
    try:
        for entry in records:
            card_id = entry["cardId"]
            masked = {key: value for key, value in entry.items() if key != "cardId"}
            envelope = cipher.seal(
                json.dumps(masked, sort_keys=True, separators=(",", ":")),
                conversation_id="",
                message_id=card_id,
                sender_user_id=owner,
            )
            projection["cards"].append({"cardId": card_id, **envelope})
    except DirectMessagesError:
        # Saving the owner's encrypted card must survive an unavailable sharing key.
        projection["cards"] = []
    return projection


def wallet_manifest_source(owner, domain, summary, manifest_row):
    """Returns stable fingerprint input; only encrypted information enters the manifest."""
    if domain != "wallet":
        return None
    records = wallet_source_records(summary)
    manifest_row["summary_projection"][PROJECTION_KEY] = seal_wallet_source(owner, records)
    return records


def fingerprint_manifest(manifest_row):
    return {
        **manifest_row,
        "summary_projection": {
            key: value
            for key, value in manifest_row["summary_projection"].items()
            if key != PROJECTION_KEY
        },
    }
