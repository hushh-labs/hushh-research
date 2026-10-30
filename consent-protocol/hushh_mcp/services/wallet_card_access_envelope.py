"""Bounded recipient ciphertext only. Never accept plaintext card credentials."""

import json
import re
from uuid import UUID


def validate_recipient_card(content, card_id):
    prefix = "hushh-wallet-card:v1:"
    if not isinstance(content, str) or len(content) > 4096 or not content.startswith(prefix):
        raise ValueError("invalid encrypted card")
    value = json.loads(content[len(prefix) :])
    if set(value) != {"shareId", "cardId", "payload", "senderKey", "recipientKey"}:
        raise ValueError("invalid encrypted card")
    UUID(value["shareId"])
    if value["cardId"] != card_id:
        raise ValueError("invalid encrypted card")
    payload = value["payload"]
    if set(payload) != {"ciphertext", "iv", "tag"}:
        raise ValueError("invalid encrypted card")
    for name, pattern in {
        "ciphertext": r"[A-Za-z0-9+/]{1,900}={0,2}",
        "iv": r"[A-Za-z0-9+/]{16}",
        "tag": r"[A-Za-z0-9+/]{22}==",
    }.items():
        if not isinstance(payload[name], str) or not re.fullmatch(pattern, payload[name]):
            raise ValueError("invalid encrypted card")
    for field in ("senderKey", "recipientKey"):
        key = value[field]
        if set(key) != {
            "algorithm",
            "recipientKeyId",
            "senderEphemeralPublicKeyJwk",
            "iv",
            "ciphertext",
        }:
            raise ValueError("invalid encrypted card")
        if (
            key["algorithm"] != "ECDH-P256-AES256-GCM"
            or not isinstance(key["recipientKeyId"], str)
            or not 1 <= len(key["recipientKeyId"]) <= 160
        ):
            raise ValueError("invalid encrypted card")
        for name, size in (("iv", 16), ("ciphertext", 64)):
            if not isinstance(key[name], str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{%d}" % size, key[name]
            ):
                raise ValueError("invalid encrypted card")
        jwk = key["senderEphemeralPublicKeyJwk"]
        if (
            not isinstance(jwk, dict)
            or set(jwk) - {"kty", "crv", "x", "y", "ext", "key_ops"}
            or jwk.get("kty") != "EC"
            or jwk.get("crv") != "P-256"
        ):
            raise ValueError("invalid encrypted card")
        for coord in ("x", "y"):
            if not isinstance(jwk.get(coord), str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{43}", jwk[coord]
            ):
                raise ValueError("invalid encrypted card")
        if jwk.get("key_ops", []) != [] or jwk.get("ext", True) is not True:
            raise ValueError("invalid encrypted card")
    return content
