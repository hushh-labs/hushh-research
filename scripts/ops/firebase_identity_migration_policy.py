# SPDX-License-Identifier: Apache-2.0
"""UID-preserving Dev import records and provider-native comparison rules."""

from __future__ import annotations
import base64
import hashlib
import json

SOURCE = "hushh-pda"

TARGET = "hushh-pda-dev"
UAT_TARGET = "hushh-pda-uat"

MARKER = "hussh_auth_migration"

FIELDS = (
    "localId",
    "email",
    "emailVerified",
    "displayName",
    "photoUrl",
    "phoneNumber",
    "passwordHash",
    "salt",
    "validSince",
    "createdAt",
    "providerUserInfo",
    "mfaInfo",
)

CLAIMS = {
    "hushhLinkedMailed",
    "hushhLinkedSeen",
    "hushhWelcomeMailAt",
    "workosOrgId",
    "workosUserId",
    "workosOrigin",
    "workosDeprovisionedAt",
}


class Refused(RuntimeError):
    """A static refusal code; never a provider body or private account value."""


def require(condition, code):
    if not condition:
        raise Refused(code)


def manifest_target(manifest):
    target = manifest.get("targetProject")
    require(manifest.get("sourceProject") == SOURCE, "SOURCE_PROJECT_CHANGED")
    require(
        (target == TARGET and manifest.get("schema") == "hussh.dev-auth-import.v1")
        or (
            target == UAT_TARGET
            and manifest.get("schema") == "hussh.uat-auth-import.v2"
        ),
        "MIGRATION_REALM_UNQUALIFIED",
    )
    return target


def retained_preimages(selected, actual):
    """Adopt only existing, credential-free app-owned UIDs; never overwrite them."""
    result = {}
    for native in actual:
        uid = native["localId"]
        require(uid in selected, "FOREIGN_TARGET_IDENTITY")
        for user in (native, selected[uid]):
            normalized = record(user)
            require(
                not normalized["disabled"]
                and json.loads(normalized["customAttributes"]) == {}
                and not any(
                    normalized.get(key)
                    for key in (
                        "email",
                        "phoneNumber",
                        "providerUserInfo",
                        "passwordHash",
                        "salt",
                        "mfaInfo",
                    )
                ),
                "RETAINED_TARGET_HAS_INDEPENDENT_AUTHORITY",
            )
        digest = identity_hash(uid)
        require(digest not in result, "TARGET_DUPLICATE_UID")
        result[digest] = {"recordSha256": sha(record(native))}
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def identity_hash(uid):
    return "sha256:" + hashlib.sha256(uid.encode()).hexdigest()


def record(user):
    """Security/preservation fields; volatile login/refresh times are not a fence."""
    require(
        isinstance(user.get("localId"), str) and 0 < len(user["localId"]) <= 128,
        "USER_ID_INVALID",
    )
    require(
        not user.get("tenantId") and not user.get("rawPassword"), "UNSUPPORTED_USER"
    )
    claims = json.loads(user.get("customAttributes") or "{}")
    require(isinstance(claims, dict) and not set(claims) - CLAIMS, "CLAIMS_NEED_REVIEW")
    result = {key: user[key] for key in FIELDS if key in user}
    result.update(
        disabled=bool(user.get("disabled")), customAttributes=canonical(claims)
    )
    for key in ("providerUserInfo", "mfaInfo"):
        if key in result:
            result[key] = sorted(result[key], key=canonical)
    # Password and phone providers are derived from the top-level credentials.
    # Federated imports use the SDK's canonical provider input fields; exported
    # federatedId is a provider-derived compatibility projection, not another link.
    providers = []
    for provider in result.get("providerUserInfo", []):
        kind = provider.get("providerId")
        if kind == "password":
            require(
                result.get("passwordHash") and result.get("email"),
                "PASSWORD_HASH_REQUIRED",
            )
            continue
        if kind == "phone":
            require(
                result.get("phoneNumber")
                and provider.get("rawId") == result["phoneNumber"],
                "PHONE_PROVIDER_MISMATCH",
            )
            continue
        require(
            kind in {"google.com", "apple.com", "microsoft.com"}
            and provider.get("rawId"),
            "PROVIDER_NEEDS_QUALIFICATION",
        )
        providers.append(
            {
                key: provider[key]
                for key in ("providerId", "rawId", "email", "displayName", "photoUrl")
                if key in provider
            }
        )
    result["providerUserInfo"] = sorted(providers, key=canonical)
    return result


def hash_parameters(config):
    """Use the pinned SDK's pure v1 encoding, without its retrying HTTP client."""
    from firebase_admin import auth

    require(config.get("algorithm") == "SCRYPT", "UNSUPPORTED_PASSWORD_HASH")
    return auth.UserImportHash.scrypt(
        base64.urlsafe_b64decode(config["signerKey"]),
        rounds=config["rounds"],
        memory_cost=config["memoryCost"],
        salt_separator=base64.urlsafe_b64decode(config.get("saltSeparator", "")),
    ).to_dict()


def staged_record(user, operation):
    result = record(user)
    claims = json.loads(result["customAttributes"])
    claims[MARKER] = operation
    result.update(disabled=True, customAttributes=canonical(claims))
    require(len(result["customAttributes"].encode()) <= 1000, "CLAIMS_TOO_LARGE")
    return result


def staged_differences(actual, wanted, operation):
    if actual.get("disabled") is not True:
        return ["disabled"]
    claims = json.loads(actual.get("customAttributes") or "{}")
    if claims.pop(MARKER, None) != operation:
        return ["migrationMarker"]
    cleaned = {**actual, "customAttributes": canonical(claims)}
    try:
        observed = record(cleaned)
    except (Refused, ValueError, TypeError):
        return ["invalidRecord"]
    extras = unexpected_credentials(observed, wanted)
    if extras:
        return extras
    # Native export may add informational defaults absent from the import.
    observed = {key: observed.get(key) for key in wanted}
    expected = {**wanted, "disabled": True}
    differences = []
    for key, value in expected.items():
        actual_value = observed.get(key)
        if actual_value == value:
            continue
        # Identity Platform advances this cutoff during import. A newer cutoff
        # revokes more sessions; losing or lowering the source cutoff refuses.
        if key == "validSince" and str(actual_value).isdigit() and str(value).isdigit():
            if int(actual_value) >= int(value):
                continue
        differences.append(key)
    return sorted(differences)


def matches_staged(actual, wanted, operation):
    return not staged_differences(actual, wanted, operation)


def unexpected_credentials(observed, wanted):
    defaults = {
        "email": "",
        "emailVerified": False,
        "phoneNumber": "",
        "passwordHash": "",
        "salt": "",
        "mfaInfo": [],
        "providerUserInfo": [],
    }
    return sorted(
        key
        for key, empty in defaults.items()
        if key not in wanted and observed.get(key, empty) != empty
    )
