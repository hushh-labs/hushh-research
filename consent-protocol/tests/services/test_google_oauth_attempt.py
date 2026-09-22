import json

import pytest

from hushh_mcp.services.google_oauth_attempt import (
    connection_generation,
    decode_attempt,
    encode_attempt,
)


def test_attempt_binds_version_transport_and_start_generation():
    generation = connection_generation(None)
    value = encode_attempt(verifier="v" * 64, generation=generation, transport="web")
    assert decode_attempt(value, transport="web") == {
        "verifier": "v" * 64,
        "generation": generation,
    }
    with pytest.raises(ValueError):
        decode_attempt(value, transport="native")


@pytest.mark.parametrize(
    "value",
    [
        "legacy-verifier",
        "null",
        "[]",
        "{}",
        json.dumps(
            {"version": 1, "transport": "web", "verifier": "v" * 64, "generation": "x" * 64}
        ),
        json.dumps({"version": 2, "transport": "web"}),
    ],
)
def test_legacy_or_malformed_attempt_never_acquires_current_generation(value):
    with pytest.raises(ValueError):
        decode_attempt(value, transport="web")


def test_refresh_access_token_does_not_change_connection_generation():
    row = {
        "provider_subject": "synthetic-subject",
        "status": "connected",
        "refresh_token_ciphertext": "synthetic-r1",
        "access_token_ciphertext": "synthetic-a1",
    }
    assert connection_generation(row) == connection_generation(
        row | {"access_token_ciphertext": "synthetic-a2"}
    )
    for change in [
        {"refresh_token_ciphertext": "synthetic-r2"},
        {"status": "disconnected", "refresh_token_ciphertext": None},
        {"provider_subject": "synthetic-other"},
    ]:
        assert connection_generation(row) != connection_generation(row | change)
    assert connection_generation(None) != connection_generation({})
