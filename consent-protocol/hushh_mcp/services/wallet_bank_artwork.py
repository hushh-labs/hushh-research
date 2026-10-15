"""Owner-chosen cosmetic bank designs; this module never identifies a card."""

import hashlib

from hushh_mcp.services.wallet_artwork_catalog import (
    ArtworkCatalog,
    approved_assets,
    artwork_variant,
    load_catalog,
    selection_ready,
)
from hushh_mcp.services.wallet_card_validation import NETWORK_ORDER


def bank_designs(
    network: str,
    country: str | None = None,
    bank_key: str | None = None,
    offset: int = 0,
    *,
    catalog: ArtworkCatalog | None = None,
) -> dict:
    if network not in NETWORK_ORDER or offset < 0 or offset > 10000:
        raise ValueError("invalid_bank_request")
    catalog = catalog or load_catalog()[0]
    groups = {}
    for asset in approved_assets(catalog):
        if (
            not asset.bank_design
            or not asset.selectable
            or not selection_ready(catalog, asset)
            or asset.network != network
            or (country and asset.country != country)
        ):
            continue
        key = hashlib.sha256(
            f"{asset.provider_id or 'local'}\0{asset.issuer_id}\0{asset.country}".encode()
        ).hexdigest()[:32]
        group = groups.setdefault(
            key,
            {
                "bankKey": key,
                "issuerId": asset.issuer_id,
                "name": asset.issuer_name or asset.issuer_id,
                "country": asset.country,
                "assets": [],
            },
        )
        if group["name"] != (asset.issuer_name or asset.issuer_id):
            raise ValueError("ambiguous_bank")
        group["assets"].append(asset)
    if len(groups) > 1000:
        raise ValueError("bank_catalog_too_large")
    banks = [
        {k: v for k, v in group.items() if k != "assets"} | {"designCount": len(group["assets"])}
        for group in groups.values()
    ]
    banks.sort(key=lambda row: (row["name"].casefold(), row["country"], row["bankKey"]))
    if bank_key and bank_key not in groups:
        raise ValueError("bank_unavailable")
    assets = sorted(groups[bank_key]["assets"], key=lambda row: row.asset_id) if bank_key else []
    return {
        "catalogVersion": catalog.version,
        "selectionBasis": "owner_selected_bank",
        "requiresConfirmation": True,
        "banks": banks,
        "bankKey": bank_key,
        "variants": [artwork_variant(asset) for asset in assets[offset : offset + 24]],
        "nextOffset": offset + 24 if len(assets) > offset + 24 else None,
    }
