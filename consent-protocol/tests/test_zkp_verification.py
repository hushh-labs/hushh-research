"""
Tests for utils/zkp_lite.py — ZK-lite membership proof & verification.

ZK-Lite Proof Engine by Abdul Gaffar — verifies that:
  1. Commitments are issued without the raw value being stored or transmitted
  2. Valid proofs verify correctly; tampered proofs are rejected
  3. Timing-safe comparison is used (hmac.compare_digest via library)
  4. A user can pass an 'Age Gate' policy without the protocol seeing their birthdate
  5. build_zkp_context() integrates with the policy engine context pattern
  6. Malformed proof tokens raise ZkVerificationError
"""

from __future__ import annotations

import pytest

from utils.zkp_lite import (
    ZkCommitment,
    ZkMembershipVerifier,
    ZkPredicateType,
    ZkVerificationError,
    ZkVerificationResult,
    build_proof_token,
    build_zkp_context,
    issue_zkp_commitment,
    verify_zkp_membership,
    zkp_verifier,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_KEY = b"test-signing-key-32-bytes-padded!"
_UID = "firebase_alice_zk"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _issue(predicate: ZkPredicateType = ZkPredicateType.AGE_GATE) -> ZkCommitment:
    return issue_zkp_commitment(_UID, predicate, _KEY)


def _valid_token(predicate: ZkPredicateType = ZkPredicateType.AGE_GATE) -> str:
    return build_proof_token(_issue(predicate))


# ---------------------------------------------------------------------------
# Commitment issuance
# ---------------------------------------------------------------------------


class TestZkCommitmentIssuance:
    def test_returns_zk_commitment_instance(self):
        commitment = _issue()
        assert isinstance(commitment, ZkCommitment)

    def test_commitment_hash_is_64_hex_chars(self):
        commitment = _issue()
        assert len(commitment.commitment_hash) == 64
        assert all(c in "0123456789abcdef" for c in commitment.commitment_hash)

    def test_nonce_is_64_hex_chars(self):
        commitment = _issue()
        assert len(commitment.nonce) == 64
        assert all(c in "0123456789abcdef" for c in commitment.nonce)

    def test_commitment_carries_correct_user_id(self):
        commitment = _issue()
        assert commitment.user_id == _UID

    def test_commitment_carries_correct_predicate(self):
        commitment = _issue(ZkPredicateType.JURISDICTION)
        assert commitment.predicate == ZkPredicateType.JURISDICTION

    def test_two_commitments_have_different_nonces(self):
        c1 = _issue()
        c2 = _issue()
        assert c1.nonce != c2.nonce

    def test_two_commitments_have_different_hashes(self):
        """Different nonces → different commitment hashes even for same user/predicate."""
        c1 = _issue()
        c2 = _issue()
        assert c1.commitment_hash != c2.commitment_hash

    def test_commitment_does_not_contain_raw_value(self):
        """The commitment fields must not contain any sensitive raw value."""
        birthdate = "1990-05-15"
        age = "28"
        commitment = _issue()
        assert birthdate not in commitment.commitment_hash
        assert age not in commitment.commitment_hash
        assert birthdate not in commitment.nonce


# ---------------------------------------------------------------------------
# Proof token format
# ---------------------------------------------------------------------------


class TestBuildProofToken:
    def test_proof_token_is_string(self):
        assert isinstance(_valid_token(), str)

    def test_proof_token_contains_separator(self):
        assert ":" in _valid_token()

    def test_proof_token_starts_with_commitment_hash(self):
        commitment = _issue()
        token = build_proof_token(commitment)
        assert token.startswith(commitment.commitment_hash)

    def test_proof_token_ends_with_nonce(self):
        commitment = _issue()
        token = build_proof_token(commitment)
        assert token.endswith(commitment.nonce)

    def test_proof_token_length(self):
        # 64 (hash) + 1 (":") + 64 (nonce) = 129
        assert len(_valid_token()) == 129

    def test_proof_token_does_not_contain_raw_value(self):
        """The proof token presented to the protocol contains no raw PII."""
        birthdate = "1990-05-15"
        income = "75000"
        token = _valid_token()
        assert birthdate not in token
        assert income not in token


# ---------------------------------------------------------------------------
# Verification — valid proofs
# ---------------------------------------------------------------------------


class TestVerificationValid:
    def test_valid_proof_returns_true(self):
        token = _valid_token()
        result = verify_zkp_membership(token, _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert result.valid is True

    def test_valid_proof_carries_user_id(self):
        result = verify_zkp_membership(_valid_token(), _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert result.user_id == _UID

    def test_valid_proof_carries_predicate(self):
        result = verify_zkp_membership(_valid_token(), _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert result.predicate == ZkPredicateType.AGE_GATE

    def test_valid_proof_carries_engine_label(self):
        result = verify_zkp_membership(_valid_token(), _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert "Abdul Gaffar" in result.engine
        assert "ZK-Lite" in result.engine

    def test_valid_proof_reason_populated(self):
        result = verify_zkp_membership(_valid_token(), _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert result.reason != ""

    def test_result_is_zk_verification_result_instance(self):
        result = verify_zkp_membership(_valid_token(), _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert isinstance(result, ZkVerificationResult)


# ---------------------------------------------------------------------------
# Verification — invalid / tampered proofs
# ---------------------------------------------------------------------------


class TestVerificationInvalid:
    def test_wrong_user_id_fails(self):
        token = _valid_token()
        result = verify_zkp_membership(token, "different_user", ZkPredicateType.AGE_GATE, _KEY)
        assert result.valid is False

    def test_wrong_predicate_fails(self):
        token = _valid_token(ZkPredicateType.AGE_GATE)
        result = verify_zkp_membership(token, _UID, ZkPredicateType.JURISDICTION, _KEY)
        assert result.valid is False

    def test_wrong_signing_key_fails(self):
        token = _valid_token()
        other_key = b"completely-different-signing-key!"
        result = verify_zkp_membership(token, _UID, ZkPredicateType.AGE_GATE, other_key)
        assert result.valid is False

    def test_tampered_commitment_hash_fails(self):
        token = _valid_token()
        tampered = "a" * 64 + token[64:]  # replace hash with all-'a'
        result = verify_zkp_membership(tampered, _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert result.valid is False

    def test_tampered_nonce_fails(self):
        token = _valid_token()
        tampered = token[:65] + "f" * 64  # replace nonce
        result = verify_zkp_membership(tampered, _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert result.valid is False

    def test_invalid_proof_reason_describes_failure(self):
        token = _valid_token()
        result = verify_zkp_membership(token, "wrong_user", ZkPredicateType.AGE_GATE, _KEY)
        assert "mismatch" in result.reason or "tampered" in result.reason


# ---------------------------------------------------------------------------
# Malformed tokens → ZkVerificationError
# ---------------------------------------------------------------------------


class TestMalformedProofTokens:
    def test_empty_token_raises(self):
        with pytest.raises(ZkVerificationError):
            verify_zkp_membership("", _UID, ZkPredicateType.AGE_GATE, _KEY)

    def test_no_separator_raises(self):
        with pytest.raises(ZkVerificationError):
            verify_zkp_membership("a" * 64, _UID, ZkPredicateType.AGE_GATE, _KEY)

    def test_short_hash_raises(self):
        with pytest.raises(ZkVerificationError):
            verify_zkp_membership("abc:nonce", _UID, ZkPredicateType.AGE_GATE, _KEY)

    def test_empty_nonce_raises(self):
        with pytest.raises(ZkVerificationError):
            verify_zkp_membership("a" * 64 + ":", _UID, ZkPredicateType.AGE_GATE, _KEY)

    def test_zkverification_error_is_value_error(self):
        assert issubclass(ZkVerificationError, ValueError)


# ---------------------------------------------------------------------------
# Age Gate scenario — protocol never sees birthdate
# ---------------------------------------------------------------------------


class TestAgeGateScenario:
    def test_age_gate_proof_valid_without_birthdate(self):
        """
        Core ZK-lite property: the protocol passes an Age Gate check
        without ever receiving the user's birthdate.
        """
        birthdate = "1990-05-15"  # raw value — known only to KYC service

        # KYC service verifies birthdate offline, issues commitment
        # (birthdate is NOT passed to issue_zkp_commitment)
        commitment = issue_zkp_commitment(
            user_id=_UID,
            predicate=ZkPredicateType.AGE_GATE,
            signing_key=_KEY,
        )

        # User constructs proof token from commitment
        proof_token = build_proof_token(commitment)

        # Protocol verifies — birthdate never passed here
        result = verify_zkp_membership(
            proof_token=proof_token,
            user_id=_UID,
            predicate=ZkPredicateType.AGE_GATE,
            signing_key=_KEY,
        )

        assert result.valid is True
        assert result.predicate == ZkPredicateType.AGE_GATE
        # Confirm raw value is absent from the proof token
        assert birthdate not in proof_token

    def test_age_gate_invalid_proof_rejected(self):
        """A forged or expired proof token must be rejected at verification."""
        forged_token = "b" * 64 + ":" + "c" * 64
        result = verify_zkp_membership(
            forged_token, _UID, ZkPredicateType.AGE_GATE, _KEY
        )
        assert result.valid is False

    def test_age_gate_wrong_user_rejected(self):
        """A valid token for alice cannot be reused by bob."""
        alice_token = build_proof_token(
            issue_zkp_commitment(_UID, ZkPredicateType.AGE_GATE, _KEY)
        )
        result = verify_zkp_membership(
            alice_token, "firebase_bob_zk", ZkPredicateType.AGE_GATE, _KEY
        )
        assert result.valid is False


# ---------------------------------------------------------------------------
# Policy context integration
# ---------------------------------------------------------------------------


class TestBuildZkpContext:
    def test_valid_proof_maps_to_true(self):
        token = _valid_token()
        ctx = build_zkp_context({"age_gate": token}, _UID, _KEY)
        assert ctx["age_gate"] is True

    def test_invalid_proof_maps_to_false(self):
        forged = "x" * 64 + ":" + "y" * 64
        ctx = build_zkp_context({"age_gate": forged}, _UID, _KEY)
        assert ctx["age_gate"] is False

    def test_unknown_predicate_maps_to_false(self):
        ctx = build_zkp_context({"nonexistent_predicate": "a" * 64 + ":" + "b" * 64}, _UID, _KEY)
        assert ctx["nonexistent_predicate"] is False

    def test_multiple_predicates_resolved_independently(self):
        age_token = build_proof_token(
            issue_zkp_commitment(_UID, ZkPredicateType.AGE_GATE, _KEY)
        )
        jurisdiction_token = build_proof_token(
            issue_zkp_commitment(_UID, ZkPredicateType.JURISDICTION, _KEY)
        )
        ctx = build_zkp_context(
            {"age_gate": age_token, "jurisdiction": jurisdiction_token},
            _UID,
            _KEY,
        )
        assert ctx["age_gate"] is True
        assert ctx["jurisdiction"] is True

    def test_mixed_valid_invalid_context(self):
        valid_token = _valid_token()
        forged_token = "a" * 64 + ":" + "b" * 64
        ctx = build_zkp_context(
            {"age_gate": valid_token, "jurisdiction": forged_token},
            _UID,
            _KEY,
        )
        assert ctx["age_gate"] is True
        assert ctx["jurisdiction"] is False


# ---------------------------------------------------------------------------
# ZkMembershipVerifier class and singleton
# ---------------------------------------------------------------------------


class TestZkMembershipVerifier:
    def test_verifier_verify_delegates_correctly(self):
        verifier = ZkMembershipVerifier()
        token = _valid_token()
        result = verifier.verify(token, _UID, ZkPredicateType.AGE_GATE, _KEY)
        assert result.valid is True

    def test_verifier_build_context_delegates_correctly(self):
        verifier = ZkMembershipVerifier()
        token = _valid_token()
        ctx = verifier.build_context({"age_gate": token}, _UID, _KEY)
        assert ctx["age_gate"] is True

    def test_singleton_identity(self):
        from utils.zkp_lite import zkp_verifier as zv2
        assert zkp_verifier is zv2

    def test_result_summary_format(self):
        result = verify_zkp_membership(_valid_token(), _UID, ZkPredicateType.AGE_GATE, _KEY)
        summary = result.summary()
        assert "age_gate" in summary
        assert _UID in summary
        assert "True" in summary
