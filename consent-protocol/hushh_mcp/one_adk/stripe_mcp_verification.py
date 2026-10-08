"""Explicit Stripe verification composed through the governed native read port.

No catalog refresh executes these calls, no receipt is persisted, and no SDK
credential can replace the owner's OAuth connection.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.stripe_mcp_reads import ACCOUNT_TOOL, BALANCE_TOOL, stripe_read_arguments


async def verify_stripe_account(
    toolset: Any, context: Any, *, approved_read=None
) -> dict[str, Any]:
    async with asyncio.timeout(toolset.timeout_seconds):
        return await _verify_stripe_account(toolset, context, approved_read=approved_read)


async def _verify_stripe_account(
    toolset: Any, context: Any, *, approved_read=None
) -> dict[str, Any]:
    toolset.stripe_proof = None
    tools = await toolset.get_tools(context)
    selected = {tool.descriptor["name"]: tool for tool in tools}
    if not all(name in selected for name in (ACCOUNT_TOOL, BALANCE_TOOL)):
        raise ExternalMcpError(
            "The Stripe account contract is unavailable.", code="MCP_STRIPE_SCHEMA_UNSUPPORTED"
        )
    # One consumed approval covers only its exact original read. Check the
    # companion policy before dispatch; never borrow that approval for a pair.
    for name in (ACCOUNT_TOOL, BALANCE_TOOL):
        tool = selected[name]
        arguments = stripe_read_arguments(name, toolset.stripe_account_id)
        exact_approved = approved_read == (toolset.binding, tool.name, tool.revision, arguments)
        if toolset.review_outcome(tool.name, tool.descriptor) == "required" and not exact_approved:
            raise ExternalMcpError("Review this Stripe read.", code="MCP_STRIPE_REVIEW_REQUIRED")
    headers = await toolset._current_headers(context)
    epoch, fingerprint = toolset.catalog_epoch, toolset._catalog_digest
    values = {}
    for name in (ACCOUNT_TOOL, BALANCE_TOOL):
        if await toolset._current_headers(context) != headers:
            raise ExternalMcpError("Connection changed.", code="MCP_CONNECTION_CHANGED")
        values[name] = await selected[name].run_verification_read(
            args=stripe_read_arguments(name, toolset.stripe_account_id),
            tool_context=context,
            approved_read=approved_read,
        )
        if (
            await toolset._current_headers(context) != headers
            or epoch != toolset.catalog_epoch
            or fingerprint != toolset._catalog_digest
        ):
            raise ExternalMcpError("Connection changed.", code="MCP_CONNECTION_CHANGED")
    proof = {
        "verifiedAt": datetime.now(UTC).isoformat(),
        "configurationRevision": (
            toolset.binding.authority_revision[1]
            if toolset.binding.authority_revision[:1] == ("vault",)
            else None
        ),
        "catalogFingerprint": fingerprint,
    }
    toolset.stripe_proof = proof
    return {"account": values[ACCOUNT_TOOL], "balance": values[BALANCE_TOOL], **proof}


async def run_verification_read(tool, *, args, tool_context, approved_read=None):
    """Closed read port; one exact approval never covers its companion."""

    from hushh_mcp.one_adk.governed_mcp_toolset import (
        _audit_unreviewed_call,
        _GovernedMcpTool,
        validated_mcp_arguments,
    )
    from hushh_mcp.one_adk.mcp_result_projection import project_mcp_result
    from hushh_mcp.services.stripe_mcp_policy import official_stripe_endpoint, require_stripe_tool
    from hushh_mcp.services.stripe_mcp_reads import ACCOUNT_TOOLS, stripe_read_projection

    owner = tool.toolset
    if not official_stripe_endpoint(owner.binding.endpoint):
        raise ExternalMcpError("Verification read unavailable.", code="MCP_STRIPE_READ_ONLY")
    require_stripe_tool(owner.binding.endpoint, tool.descriptor, owner.stripe_reads)
    if tool.descriptor["name"] not in ACCOUNT_TOOLS:
        raise ExternalMcpError("Verification read unavailable.", code="MCP_STRIPE_READ_ONLY")
    await owner.get_tools(tool_context)
    if tool.epoch != owner.catalog_epoch:
        raise ExternalMcpError("Catalog changed.", code="MCP_CATALOG_CHANGED")
    arguments = validated_mcp_arguments(tool.descriptor["inputSchema"], args)
    validated_mcp_arguments(tool.provider_schema, arguments)
    outcome = owner.review_outcome(tool.name, tool.descriptor)
    exact_approved = approved_read == (owner.binding, tool.name, tool.revision, arguments)
    if outcome == "required" and not exact_approved:
        raise ExternalMcpError("Review this Stripe read.", code="MCP_STRIPE_REVIEW_REQUIRED")
    if not exact_approved:
        _audit_unreviewed_call(tool_context, owner.binding, tool.name, outcome)
    async with asyncio.timeout(owner.timeout_seconds):
        result = await super(_GovernedMcpTool, tool)._run_async_impl(
            args=arguments, tool_context=tool_context, credential=None
        )
    headers = await owner._current_headers(tool_context)
    await owner.get_tools(tool_context)
    if tool.epoch != owner.catalog_epoch:
        raise ExternalMcpError("Catalog changed.", code="MCP_CATALOG_CHANGED")
    normalized = project_mcp_result(
        result,
        headers,
        tool.descriptor["name"],
        lambda name, payload: stripe_read_projection(name, payload, owner.stripe_account_id),
    )
    if normalized.is_error or normalized.truncated:
        raise ExternalMcpError("Stripe read unavailable.", code="MCP_STRIPE_RECEIPT_INVALID")
    return normalized.payload


async def run_verified_stripe_result(tool, context, *, reviewed, outcome, arguments):
    verified = await verify_stripe_account(
        tool.toolset,
        context,
        approved_read=(
            tool.toolset.binding,
            tool.name,
            tool.revision,
            arguments,
        )
        if reviewed
        else None,
    )
    return {
        "status": "ok",
        "isError": False,
        "result": verified["account" if tool.descriptor["name"] == ACCOUNT_TOOL else "balance"],
        "truncated": False,
        "review": "approved" if reviewed else outcome,
    }
