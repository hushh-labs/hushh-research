"""A key removal cannot clear an AI choice made by another owner session."""

from tests.test_pod_ai_selection_doors import (
    HUB,
    OWNER_SESSION,
    PATH,
    _client,
    _envelope,
    _now_ms,
)

pytest_plugins = ("tests.test_pod_ai_selection_doors",)


async def test_clear_requires_the_observed_selection_revision(pod, owner_session):
    client = _client()
    issued = _now_ms()
    assert client.put(PATH, json=_envelope(issued), headers=OWNER_SESSION).status_code == 200
    first = client.get(PATH, headers=OWNER_SESSION).json()
    revision = first["selectionRevision"]
    assert isinstance(revision, int) and revision > 0

    # A different selection wins while another tab is removing the old key.
    assert (
        client.put(
            PATH,
            json=_envelope(issued + 1, provider="gemini", transport="developer_api"),
            headers=OWNER_SESSION,
        ).status_code
        == 200
    )
    clear = client.post(
        PATH + "/clear-if-current",
        json={"expectedProvider": "openai", "expectedSelectionRevision": revision},
        headers=OWNER_SESSION,
    )
    assert clear.status_code == 409
    current = client.get(PATH, headers=OWNER_SESSION).json()
    assert current["provider"] == "gemini"
    assert current["selectionRevision"] != revision

    clear = client.post(
        PATH + "/clear-if-current",
        json={
            "expectedProvider": "gemini",
            "expectedSelectionRevision": current["selectionRevision"],
        },
        headers=OWNER_SESSION,
    )
    assert clear.status_code == 200 and clear.json()["status"] == "cleared"
    assert client.get(PATH, headers=OWNER_SESSION).json()["configured"] is False


async def test_conditional_clear_refuses_unadmitted_and_malformed_requests(pod, owner_session):
    client = _client()
    path = PATH + "/clear-if-current"
    payload = {"expectedProvider": "openai", "expectedSelectionRevision": 1}
    assert client.post(path, json=payload, headers=HUB).status_code == 403
    for bad in (
        {},
        {**payload, "extra": "not allowed"},
        {**payload, "expectedSelectionRevision": True},
        {**payload, "expectedProvider": []},
    ):
        assert client.post(path, json=bad, headers=OWNER_SESSION).status_code == 400
    assert client.post(path, content="x" * 513, headers=OWNER_SESSION).status_code == 400


async def test_conditional_clear_rechecks_after_a_competing_log_commit(
    pod, owner_session, monkeypatch
):
    client = _client()
    assert client.put(PATH, json=_envelope(_now_ms()), headers=OWNER_SESSION).status_code == 200
    current = client.get(PATH, headers=OWNER_SESSION).json()
    original_append = pod.append
    raced = False

    async def append(kind, payload, *, expected_seq=None):
        nonlocal raced
        if kind == "pod_ai_selection_v1" and payload.get("cleared") and not raced:
            raced = True
            records = await pod.replay()
            previous = next(r["payload"] for r in reversed(records) if r["kind"] == kind)
            await original_append(
                kind,
                {**previous, "provider": "gemini", "issuedAtMs": previous["issuedAtMs"] + 1},
                expected_seq=expected_seq,
            )
        return await original_append(kind, payload, expected_seq=expected_seq)

    monkeypatch.setattr(pod, "append", append)
    result = client.post(
        PATH + "/clear-if-current",
        headers=OWNER_SESSION,
        json={
            "expectedProvider": "openai",
            "expectedSelectionRevision": current["selectionRevision"],
        },
    )
    assert raced and result.status_code == 409
    assert client.get(PATH, headers=OWNER_SESSION).json()["provider"] == "gemini"
