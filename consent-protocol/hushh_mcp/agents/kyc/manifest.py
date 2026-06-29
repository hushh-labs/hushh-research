"""Agent KYC manifest."""

from hushh_mcp.constants import ConsentScope

KYC_WORKFLOW_STATES = (
    "needs_client_connector",
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
        ConsentScope.AGENT_KYC_REDRAFT_LLM,
        ConsentScope.PKM_WRITE,
        ConsentScope.AGENT_KYC_REDRAFT_LLM,
    ],
    "workflow_states": KYC_WORKFLOW_STATES,
    "specialists": [],
    "capabilities": {
        "requirements_review": True,
        "missing_document_state": True,
        "approval_gated_drafts": True,
        "drafting_contract_owned_by_adk": True,
        "strict_client_zk_draft_rendering": True,
        "approved_disclosure_formatter": {
            "contract_id": "agent_kyc.approved_disclosure_formatter.v1",
            "contract_version": "1.0.0",
            "input_schema": "ApprovedDisclosureRenderInput",
            "output_schema": "ApprovedDisclosureRenderModel",
            "client_executor": "hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts",
            "strict_client_zk": True,
            "backend_plaintext_allowed": False,
        },
        "llm_redraft_tokenized": {
            "enabled": True,
            "mechanism": "pii_tokenization_redact_rewrite_refill",
            "carve_out": "pii_free_template_transits_backend_to_gemini_transiently",
            "guarantees": {
                "no_real_pii_value_transmitted": True,
                "no_persist": True,
                "no_log_of_body": True,
                "draft_body_null_constraint_unchanged": True,
            },
            "scope_required": "agent.kyc.redraft.llm",
            "rationale": (
                "Real PII values never leave the device. The backend transiently forwards "
                "a PII-free template (prose + {{F0}}...{{FN}} placeholders) to Gemini Vertex "
                "for rewriting. The token->value map and re-substitution are browser-only. "
                "This is a narrowing of the transit rule, not a relaxation of the value gate: "
                "strict_client_zk_draft_rendering and backend_plaintext_allowed remain unchanged."
            ),
        },
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
