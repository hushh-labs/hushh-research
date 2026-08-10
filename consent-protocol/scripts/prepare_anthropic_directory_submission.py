#!/usr/bin/env python3
"""Prepare and validate Hussh MCP for Anthropic Connectors Directory submission.

This script audits the Hussh MCP tools schema against Anthropic Connectors Directory
submission requirements (titles, readOnlyHint, destructiveHint annotations) and
generates the complete JSON submission package for the submission portal.
"""

import json
import os
import sys
from pathlib import Path

PUBLIC_TOOL_NAMES = {
    "search-user-scopes",
    "prepare-campaign-context",
    "request-consent",
    "check-consent-status",
    "get-encrypted-scoped-export",
}


def _required_environment_value(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    raise ValueError(f"Set {name} before generating a directory submission package.")


def build_submission_config() -> dict[str, object]:
    """Build the package from the five-tool public Consent MCP contract only."""
    review_account = _required_environment_value("HUSHH_DIRECTORY_REVIEW_ACCOUNT")
    test_user_identifier = _required_environment_value("HUSHH_DIRECTORY_TEST_USER_IDENTIFIER")

    return {
        "listing": {
            "name": "Hussh Consent MCP",
            "tagline": "Consent-gated encrypted exports for AI agents.",
            "description": (
                "Hussh Consent MCP provides a five-tool, least-privilege consent lifecycle for "
                "external AI agents and connectors. A connector can discover narrow scopes, "
                "prepare safe campaign context, request consent, poll its status, and retrieve an "
                "approved encrypted scoped export.\n\n"
                "Key Capabilities:\n"
                "• Least-Privilege Consent: Request and inspect scoped, encrypted exports without "
                "exposing plaintext secrets, tokens, or raw PII.\n"
                "• Scoped Consent: Request only a discovered, least-privilege scope for a stated purpose.\n"
                "• Encrypted Delivery: Retrieve approved information only as an encrypted export for "
                "connector-side decryption.\n"
                "• Bounded Lifecycle: Poll at the server-provided cadence and fail closed after denial, "
                "revocation, expiry, or an invalid grant."
            ),
            "slug": "hussh",
            "categories": ["Security & Privacy", "Developer Tools"],
            "documentation_url": "https://www.hushh.ai/developers",
            "privacy_policy_url": "https://www.hushh.ai/privacy",
            "support_email": "support@hushh.ai",
            "allowed_link_uris": [
                "https://www.hushh.ai",
                "https://api.uat.hushh.ai",
            ],
        },
        "connection": {
            "mcp_url": "https://api.uat.hushh.ai/mcp/",
            "transport": "streamable_http",
            "multi_tenant": True,
            "auth_type": "oauth2",
        },
        "compliance_acknowledgments": {
            "directory_guidelines": True,
            "first_party_api_usage": True,
            "financial_transactions_policy": True,
            "ai_media_generation_policy": True,
            "prompt_injection_safety": True,
            "conversation_data_collection": True,
            "public_documentation": True,
        },
        "test_and_launch": {
            "test_account_identifier": review_account,
            "review_instructions": (
                "1. Authenticate as the supplied review account.\n"
                f"2. Call search-user-scopes(user_identifier='{test_user_identifier}') and select a "
                "returned least-privilege scope.\n"
                "3. Call request-consent with that exact scope and a clear purpose, then poll "
                "check-consent-status only at the returned cadence.\n"
                "4. After approval, call get-encrypted-scoped-export with the grant reference and "
                "expected scope. Decrypt only in the trusted connector process."
            ),
        },
    }


def audit_tools_contract(contract_path: Path) -> tuple[bool, list[str]]:
    """Audits public contract JSON for Anthropic tool annotation rules."""
    if not contract_path.is_file():
        return False, [f"Contract file not found: {contract_path}"]

    with open(contract_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    tools = data.get("tools", [])
    errors = []
    tool_names = {tool.get("name") for tool in tools}

    print(f"Auditing {len(tools)} tools in {contract_path.name}...")

    for tool in tools:
        name = tool.get("name", "unknown")
        annotations = tool.get("annotations", {})

        # 1. Check title
        title = annotations.get("title")
        if not title:
            errors.append(f"Tool '{name}' is missing required 'title' annotation.")

        # 2. Check readOnlyHint
        read_only = annotations.get("readOnlyHint")
        if read_only is None or not isinstance(read_only, bool):
            errors.append(f"Tool '{name}' is missing required boolean 'readOnlyHint' annotation.")

        # 3. Check destructiveHint
        destructive = annotations.get("destructiveHint")
        if destructive is None or not isinstance(destructive, bool):
            errors.append(
                f"Tool '{name}' is missing required boolean 'destructiveHint' annotation."
            )

    if tool_names != PUBLIC_TOOL_NAMES:
        errors.append(
            "Public tool catalog does not match the submission's five-tool Consent MCP contract."
        )

    return len(errors) == 0, errors


def main():
    root_dir = Path(__file__).resolve().parent.parent
    contract_path = root_dir / "mcp_modules" / "tools" / "public_contract.json"

    print("=========================================================")
    print(" Hussh MCP — Anthropic Connectors Directory Submission ")
    print("=========================================================\n")

    valid, errors = audit_tools_contract(contract_path)

    if not valid:
        print("❌ TOOL ANNOTATION AUDIT FAILED:")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)

    print(
        "✅ All tool annotations (title, readOnlyHint, destructiveHint) meet Anthropic requirements!\n"
    )

    try:
        submission_config = build_submission_config()
    except ValueError as error:
        print(f"❌ SUBMISSION CONFIGURATION FAILED: {error}")
        sys.exit(1)

    # Generate output submission package
    output_dir = root_dir / "tmp"
    output_dir.mkdir(parents=True, exist_ok=True)
    submission_path = output_dir / "anthropic_mcp_directory_submission.json"

    package = {
        "submission_version": "1.0.0",
        "anthropic_directory_config": submission_config,
        "contract_audit": {"status": "PASSED", "contract_file": str(contract_path)},
    }

    with open(submission_path, "w", encoding="utf-8") as f:
        json.dump(package, f, indent=2)

    print(f"✅ Generated complete submission package at:\n   {submission_path}\n")
    print("---------------------------------------------------------")
    print("Submission Portal Steps (claude.ai/admin-settings/directory/submissions/new):")
    listing = submission_config["listing"]
    connection = submission_config["connection"]
    print(f"• Name:        {listing['name']}")
    print(f"• Tagline:     {listing['tagline']}")
    print(f"• Endpoint:    {connection['mcp_url']}")
    print(f"• Docs URL:    {listing['documentation_url']}")
    print(f"• Privacy URL: {listing['privacy_policy_url']}")
    print(f"• Support:     {listing['support_email']}")
    print("---------------------------------------------------------")


if __name__ == "__main__":
    main()
