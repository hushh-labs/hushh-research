"""Merge qualified inventory without discarding earlier mutation provenance."""

from __future__ import annotations

from copy import deepcopy


def merge_substrate_inventory(record: dict | None, observed: dict | None) -> dict | None:
    if observed is None:
        return record
    if record is None:
        return deepcopy(observed)
    result = deepcopy(record)
    for key in (
        "resourceIds",
        "plannedResources",
        "resourceObservations",
        "bindingObservations",
        "operatorBindingObservations",
    ):
        current, retained = result.get(key, []), observed.get(key, [])
        if not isinstance(current, list) or not isinstance(retained, list):
            raise ValueError("substrate inventory shape unconfirmed")
        for item in retained:
            if item not in current:
                current.append(deepcopy(item))
        if len(current) > (128 if key == "operatorBindingObservations" else 1024):
            raise ValueError("substrate inventory exceeds its retained bound")
        if key in result or current:
            result[key] = current
    observations = result.get("resourceObservations", [])
    identities = {}
    for item in observations:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("type"), str)
            or not isinstance(item.get("id"), str)
        ):
            raise ValueError("substrate creation identity unconfirmed")
        identity = (item["type"], item["id"])
        if identity in identities and identities[identity] != item:
            raise ValueError("substrate creation identity changed")
        identities[identity] = item
    return result
