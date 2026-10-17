"""Every scale-to-zero Azure agent runs with the economy idle window.

Live, 2026-10-05: the founder's Azure agent had no POD_IDLE_GRACE_SECONDS, so a
linked Puppy never closed its idle socket and held the minReplicas-0 agent warm.
New agents get it from the renderer; an update gives it to one set up earlier.
"""

from __future__ import annotations

from hushh_mcp.services.azure_agent_upgrade import replacement_body
from hushh_mcp.services.azure_container_app_renderer import _azure_env


def _app(env: list[dict], min_replicas: int = 0) -> dict:
    return {
        "location": "eastus2",
        "properties": {
            "template": {
                "containers": [{"name": "pod", "image": "old@sha256:aa", "env": env}],
                "scale": {"minReplicas": min_replicas, "maxReplicas": 1},
            }
        },
    }


def _env(body: dict) -> list[dict]:
    return body["properties"]["template"]["containers"][0]["env"]


def test_the_renderer_gives_every_new_agent_the_idle_window():
    from types import SimpleNamespace

    coords = SimpleNamespace(
        blob_url="https://s.blob.core.windows.net/pod", key_vault_key="https://kv/keys/k",
        identity_client_id="c", hub_caller_emails="hub@x", openai_endpoint="", openai_deployment="",
    )  # fmt: skip
    assert {"name": "POD_IDLE_GRACE_SECONDS", "value": "600"} in _azure_env(coords)


def test_an_update_gives_an_earlier_agent_the_idle_window_once():
    body = replacement_body(
        _app([{"name": "HUSSH_ID", "value": "ha1"}]), image="new@sha256:bb", suffix="v7"
    )
    assert {"name": "POD_IDLE_GRACE_SECONDS", "value": "600"} in _env(body)
    again = replacement_body(_app(_env(body)), image="new@sha256:cc", suffix="v8")
    assert [e for e in _env(again) if e["name"] == "POD_IDLE_GRACE_SECONDS"] == [
        {"name": "POD_IDLE_GRACE_SECONDS", "value": "600"}
    ]


def test_an_existing_value_and_a_warm_agent_are_left_alone():
    kept = replacement_body(
        _app([{"name": "POD_IDLE_GRACE_SECONDS", "value": "900"}]), image="n@sha256:bb", suffix="v7"
    )
    assert _env(kept) == [{"name": "POD_IDLE_GRACE_SECONDS", "value": "900"}]
    warm = replacement_body(_app([], min_replicas=1), image="n@sha256:bb", suffix="v7")
    assert _env(warm) == []
