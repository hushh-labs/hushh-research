"""Synthetic APNs protocol/telemetry tests, without network or provider secrets."""

import logging

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from hushh_mcp.services import direct_call_voip as voip
from mcp_modules.log_redaction import SensitiveLogFilter


def configure(monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    for name, value in {
        "TEAM_ID": "SYNTHETIC1",
        "KEY_ID": "SYNTHETIC2",
        "PRIVATE_KEY": private,
        "BUNDLE_ID": "test.synthetic.calling",
        "ENVIRONMENT": "sandbox",
    }.items():
        monkeypatch.setenv("DIRECT_CALLS_APNS_" + name, value)
    return key


def test_provider_token_reuse_rotation_and_exact_voip_headers(monkeypatch):
    key = configure(monkeypatch)
    clock = [100.0]
    monkeypatch.setattr(voip.time, "monotonic", lambda: clock[0])
    config = voip.APNSConfig.load()
    first = config.headers()
    assert first == config.headers()
    assert first["apns-topic"] == "test.synthetic.calling.voip"
    assert first["apns-expiration"] == "0" and first["apns-push-type"] == "voip"
    token = first["authorization"].removeprefix("bearer ")
    claims = jwt.decode(token, key.public_key(), algorithms=["ES256"])
    assert claims["iss"] == "SYNTHETIC1"
    assert jwt.get_unverified_header(token)["kid"] == "SYNTHETIC2"
    clock[0] += 2399
    assert config.headers() == first
    # Rotation is based on elapsed lifetime, not wall-clock bucket boundaries.
    wall = voip.time.time()
    monkeypatch.setattr(voip.time, "time", lambda: wall + 2400)
    clock[0] += 2
    assert config.headers()["authorization"] != first["authorization"]


def test_apns_url_and_authorization_are_redacted_in_real_httpx_log_shape():
    for host in ["api.push.apple.com", "api.sandbox.push.apple.com"]:
        token = "ab" * 32
        record = logging.LogRecord(
            "httpx",
            logging.INFO,
            "",
            1,
            'HTTP Request: %s %s "%s %d %s"',
            ("POST", httpx.URL(f"https://{host}/3/device/{token}"), "HTTP/2", 200, "OK"),
            None,
        )
        SensitiveLogFilter().filter(record)
        assert token not in record.getMessage()
        assert "[REDACTED]" in record.getMessage()


def test_missing_provider_configuration_fails_native_capability_closed(monkeypatch):
    monkeypatch.delenv("DIRECT_CALLS_APNS_PRIVATE_KEY", raising=False)
    assert voip.available() is False


@pytest.mark.parametrize("logger", ["httpcore.http2", "hpack.hpack", "h2.connection"])
def test_http2_debug_header_bytes_never_reveal_provider_authorization(logger):
    marker = b"synthetic-provider-authorization-must-not-reach-logs"
    record = logging.LogRecord(
        logger,
        logging.DEBUG,
        "",
        1,
        "send_request_headers.started %s",
        ({"headers": [(b"authorization", marker), (b":path", b"/3/device/synthetic-token")]},),
        None,
    )
    SensitiveLogFilter().filter(record)
    assert marker.decode() not in record.getMessage()
    assert "synthetic-token" not in record.getMessage()
