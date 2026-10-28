"""Validate proposed frontend secret-version inventories; grants no authority.

This contract does not query Secret Manager, rewrite the build recipe, or prove
that a build used these versions. Hosted integration must independently obtain
and bind provider evidence, and replace every dynamic ``latest`` access.
"""

from __future__ import annotations

import re

import frontend_release as release

REQUIRED = frozenset(
    {
        "BACKEND_URL",
        "APP_FRONTEND_ORIGIN",
        "NEXT_PUBLIC_FIREBASE_API_KEY",
        "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
        "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
        "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
        "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
        "NEXT_PUBLIC_FIREBASE_APP_ID",
        "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
        "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY",
        "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
        "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
        "NEXT_PUBLIC_GTM_ID",
    }
)
OPTIONAL_COMMON = frozenset({"NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID"})
NATIVE_DEV = frozenset(
    {
        "NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID",
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID",
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI",
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED",
    }
)
CONTACTS = "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID"
RECEIPT = "NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE"
FIXTURE_BACKEND = "PLG_QUALIFICATION_FRONTEND_BACKEND_URL"


def catalog(
    environment: str, *, fixture_backend: bool = False
) -> tuple[frozenset[str], frozenset[str]]:
    release.require(
        environment in release.TARGETS, "Frontend secret environment invalid"
    )
    release.require(
        type(fixture_backend) is bool, "Frontend secret fixture mode invalid"
    )
    required = (
        (REQUIRED - {"BACKEND_URL"}) | {FIXTURE_BACKEND}
        if fixture_backend
        else REQUIRED
    )
    if environment == "dev":
        return required, OPTIONAL_COMMON | NATIVE_DEV | {CONTACTS}
    return required | {CONTACTS}, OPTIONAL_COMMON | {RECEIPT}


def validate_inventory(
    environment: str, inventory: object, *, fixture_backend: bool = False
) -> dict:
    """Validate an exact, untrusted proposed inventory with no provider claims."""
    required, optional = catalog(environment, fixture_backend=fixture_backend)
    project = release.TARGETS[environment]
    release.require(
        isinstance(inventory, dict) and set(inventory) == required | optional,
        "Frontend secret inventory incomplete",
    )
    versions = {}
    for name in sorted(required | optional):
        item = inventory[name]
        if item is None:
            release.require(name in optional, "Frontend required secret absent")
            versions[name] = None
            continue
        release.require(
            isinstance(item, dict)
            and set(item) == {"name", "state"}
            and item.get("state") == "ENABLED"
            and isinstance(item.get("name"), str)
            and re.fullmatch(
                rf"projects/{re.escape(project)}/secrets/{re.escape(name)}/versions/[1-9][0-9]*",
                item["name"],
            )
            is not None,
            "Frontend secret version invalid",
        )
        versions[name] = item["name"]
    return {
        "environment": environment,
        "project": project,
        "versions": versions,
        "providerVerified": False,
        "consumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }
