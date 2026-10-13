namespace OneWindows.Consent;

/// <summary>
/// Mirrors validate_token()'s (valid, reason, token) tuple return shape.
/// </summary>
public sealed class TokenValidationResult
{
    public bool IsValid { get; }
    public string? Reason { get; }
    public ParsedConsentToken? Token { get; }

    private TokenValidationResult(bool isValid, string? reason, ParsedConsentToken? token)
    {
        IsValid = isValid;
        Reason = reason;
        Token = token;
    }

    public static TokenValidationResult Valid(ParsedConsentToken token) => new(true, null, token);

    public static TokenValidationResult Invalid(string reason) => new(false, reason, null);
}
