"""Agent KYC manifest."""

from hushh_mcp.constants import ConsentScope

KYC_WORKFLOW_STATES = (
    "needs_scope",
    "needs_documents",
    "drafting",
    "waiting_on_user",
    "waiting_on_counterparty",
    "completed",
    "blocked",
)

MANIFEST = {
    "agent_id": "agent_kyc",
    "name": "Agent KYC",
    "version": "0.1.0",
    "description": "Identity/KYC workflow specialist for requirements, missing-document state, approval-gated drafts, and structured PKM writeback.",
    "required_scopes": [
        ConsentScope.AGENT_KYC_PROCESS,
    ],
    "optional_scopes": [
        ConsentScope.AGENT_KYC_DRAFT,
        ConsentScope.AGENT_KYC_WRITEBACK,
        ConsentScope.PKM_WRITE,
    ],
    "workflow_states": KYC_WORKFLOW_STATES,
    "specialists": [],
    "capabilities": {
        "requirements_review": True,
        "missing_document_state": True,
        "approval_gated_drafts": True,
        "structured_pkm_writeback": True,
        "raw_thread_persistence": False,
    },
    "compliance": {
        "consent_required": True,
        "approval_required_for_outbound_send": True,
        "structured_writeback_only": True,
        "audit_trail": True,
    },
}


def get_manifest():
    """Get agent manifest."""
    return MANIFEST
