# hushh_mcp/operons/kai/storage.py

"""
Kai Storage Operons

Encrypted decision card storage with consent validation.
Follows the vault pattern from food operons.
"""

import json
import logging
from typing import Any, Dict, List

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import (
    ConsentScope,  # PKM_READ / PKM_WRITE for attr.financial.analysis.decisions.*
)
from hushh_mcp.types import EncryptedPayload, UserID
from hushh_mcp.vault.encrypt import decrypt_data, encrypt_data

logger = logging.getLogger(__name__)


# ============================================================================
# OPERON: store_decision_card
# ============================================================================


def store_decision_card(
    user_id: UserID,
    session_id: str,
    decision_card: Dict[str, Any],
    vault_key_hex: str,
    consent_token: str,
) -> EncryptedPayload:
    """
    Operon: Store encrypted decision card in vault.

    TrustLink Required: pkm.write (covers attr.financial.analysis.decisions.*)

    Args:
        user_id: User identifier
        session_id: Kai session ID
        decision_card: Complete decision card dict
        vault_key_hex: User's vault encryption key (client-provided)
        consent_token: Valid consent token

    Returns:
        EncryptedPayload ready for database storage

    Raises:
        PermissionError: If TrustLink validation fails

    Example:
        >>> payload = store_decision_card(
        ...     user_id="firebase_abc",
        ...     session_id="kai_session_123",
        ...     decision_card={"ticker": "AAPL", "decision": "buy", ...},
        ...     vault_key_hex="deadbeef...",
        ...     consent_token="HCT:..."
        ... )
    """
    # Validate TrustLink (PKM write covers attr.financial.analysis.decisions.*)
    valid, reason, token = validate_token(consent_token, ConsentScope.PKM_WRITE)

    if not valid:
        logger.error(f"[Storage Operon] TrustLink validation failed: {reason}")
        raise PermissionError(f"TrustLink validation failed: {reason}")

    if token.user_id != user_id:
        raise PermissionError(f"Token user mismatch: expected {user_id}, got {token.user_id}")

    logger.info(
        f"[Storage Operon] Storing decision for {decision_card.get('ticker')} - user {user_id}"
    )

    # Serialize decision card
    decision_json = json.dumps(decision_card)

    # Encrypt with user's vault key
    encrypted_payload = encrypt_data(decision_json, vault_key_hex)

    return encrypted_payload


# ============================================================================
# OPERON: retrieve_decision_card
# ============================================================================


def retrieve_decision_card(
    encrypted_payload: EncryptedPayload,
    vault_key_hex: str,
    consent_token: str,
    user_id: UserID,
) -> Dict[str, Any]:
    """
    Operon: Retrieve and decrypt decision card from vault.

    TrustLink Required: pkm.write (covers attr.financial.analysis.decisions.*)

    Args:
        encrypted_payload: Encrypted decision data from database
        vault_key_hex: User's vault encryption key (client-provided)
        consent_token: Valid consent token
        user_id: User identifier

    Returns:
        Decrypted decision card dict

    Raises:
        PermissionError: If TrustLink validation fails
        ValueError: If decryption fails
    """
    # Validate TrustLink (pkm.read covers attr.financial.analysis.decisions.*)
    valid, reason, token = validate_token(consent_token, ConsentScope.PKM_READ)

    if not valid:
        logger.error(f"[Storage Operon] TrustLink validation failed: {reason}")
        raise PermissionError(f"TrustLink validation failed: {reason}")

    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")

    logger.info(f"[Storage Operon] Retrieving decision for user {user_id}")

    # Decrypt using client-provided vault key
    try:
        decrypted_json = decrypt_data(encrypted_payload, vault_key_hex)
        decision_card = json.loads(decrypted_json)
        return decision_card
    except Exception as e:
        logger.error(f"[Storage Operon] Decryption failed: {e}")
        raise ValueError(f"Failed to decrypt decision card: {e}")


# ============================================================================
# OPERON: retrieve_decision_history
# ============================================================================


def retrieve_decision_history(
    user_id: UserID,
    consent_token: str,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """
    Operon: Retrieve decision history metadata (without full decryption).

    TrustLink Required: pkm.read (covers attr.financial.analysis.decisions.*)

    This returns only metadata (ticker, decision, confidence, timestamp).
    Full decision cards must be retrieved individually with vault keys.

    Args:
        user_id: User identifier
        consent_token: Valid consent token
        limit: Max number of decisions to return

    Returns:
        List of decision metadata dicts

    Raises:
        PermissionError: If TrustLink validation fails
    """
    # Validate TrustLink (pkm.read covers attr.financial.analysis.decisions.*)
    valid, reason, token = validate_token(consent_token, ConsentScope.PKM_READ)

    if not valid:
        logger.error(f"[Storage Operon] TrustLink validation failed: {reason}")
        raise PermissionError(f"TrustLink validation failed: {reason}")

    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")

    logger.info(f"[Storage Operon] Retrieving decision history for user {user_id}")

    # This operon just validates consent
    # The actual database query is done by the API endpoint
    # This ensures separation of concerns (operon = business logic, not I/O)

    return []  # Database query handled by endpoint
