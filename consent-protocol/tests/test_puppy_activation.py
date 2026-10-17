"""Wake hints cannot replace an owner's deployment-bound Puppy grant."""

from copy import deepcopy

import pytest

from hushh_mcp.services.puppy_activation import current_activation


def approved_row():
    hint = {
        "id": "a" * 32,
        "ownerId": "owner",
        "hushhId": "ha1_owner",
        "deviceId": "device",
        "podKeyId": "pod-key",
        "serviceUid": "service",
        "expiresAt": 101_000,
    }
    return {
        "user_id": "owner",
        "hushh_id": "ha1_owner",
        "status": "provisioned",
        "deployment_target": "user_gcp",
        "pod_key_id": "pod-key",
        "backend_metadata": {
            "url": "https://pod.example",
            "serviceUid": "service",
            "ingress": "direct",
            "directReadiness": {
                "verified": True,
                "url": "https://pod.example",
                "podKeyId": "pod-key",
                "serviceUid": "service",
            },
            "puppyAccess": {
                "device": {"enabled": True, "podKeyId": "pod-key", "serviceUid": "service"}
            },
            "puppyActivation": {"device": hint},
        },
    }


def test_hint_requires_current_owner_device_pod_and_unexpired_grant():
    row = approved_row()
    assert current_activation(row, "device", now_ms=100_000)
    assert current_activation(row, "other-device", now_ms=100_000) is None
    for field in ("ownerId", "hushhId", "deviceId", "podKeyId", "serviceUid"):
        altered = deepcopy(row)
        altered["backend_metadata"]["puppyActivation"]["device"][field] = "other"
        assert current_activation(altered, "device", now_ms=100_000) is None
    assert current_activation(row, "device", now_ms=101_000) is None
    assert current_activation(row, "device", now_ms=-100_000) is None


@pytest.mark.parametrize("change", ["withdrawn", "replacement", "shared", "pending", "unverified"])
def test_stale_hint_cannot_reactivate_after_authority_changes(change):
    row = approved_row()
    if change == "withdrawn":
        row["backend_metadata"]["puppyAccess"]["device"]["enabled"] = False
    elif change == "replacement":
        row["backend_metadata"]["serviceUid"] = "new-incarnation"
    elif change == "shared":
        row["deployment_target"] = "gcp"
    elif change == "pending":
        row["status"] = "provisioning"
    else:
        row["backend_metadata"]["directReadiness"]["verified"] = False
    assert current_activation(row, "device", now_ms=100_000) is None
