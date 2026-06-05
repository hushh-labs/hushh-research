class HusshError(Exception):
    """Base SDK error."""


class ConsentRevokedError(HusshError):
    """Raised when consent is revoked during an agent run."""

    def __init__(self, domain: str):
        self.domain = domain
        super().__init__(f"Consent was revoked for '{domain}'.")


class RuntimeCredentialMissingError(HusshError):
    """Raised when a BYOK runtime has no resolvable credential."""

    def __init__(self, credential_ref: str | None):
        self.credential_ref = credential_ref
        super().__init__(f"No runtime credential resolved for '{credential_ref}'.")


class RuntimeConfigError(HusshError):
    """Raised when runtime/model metadata violates the Hussh SDK contract."""
