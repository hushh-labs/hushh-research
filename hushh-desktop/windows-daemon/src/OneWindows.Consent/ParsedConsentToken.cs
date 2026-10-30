namespace OneWindows.Consent;

/// <summary>
/// Fields decoded from a validated HCT token. Mirrors the payload shape
/// produced by hushh_mcp/consent/token.py's issue_token/validate_token.
/// Scope is exposed as the raw string only -- the ConsentScope enum mapping
/// itself (scope string -> a specific named enum member) isn't ported, but
/// scope_matches() domain-isolation logic is (see ScopeMatcher).
/// </summary>
public sealed record ParsedConsentToken(
    string UserId,
    string AgentId,
    string Scope,
    long IssuedAt,
    long ExpiresAt,
    string Signature,
    bool Commercial
);
