using System.Text;

namespace OneWindows.Consent;

/// <summary>
/// C# port of hushh_mcp/consent/scope_helpers.py's scope_matches(), backed by
/// the pure-parsing subset of DynamicScopeGenerator (is_dynamic_scope,
/// parse_scope, matches_wildcard) from hushh_mcp/consent/scope_generator.py.
///
/// That generator class also owns DB-backed methods (validate_scope,
/// get_available_scope_entries, expand_wildcard, ...) which resolve a
/// user's actual PKM manifest against Supabase -- none of those are part of
/// scope_matches()'s call path and are not ported here. Only the offline
/// string-parsing subset that decides "does this granted scope satisfy this
/// requested scope" is implemented.
///
/// Verified byte-for-byte against scope_matches() via golden vectors in
/// fixtures/scope_matches_golden_vectors.json (see
/// scripts/generate_scope_golden_vectors.py) -- including a real asymmetry
/// worth knowing about: wildcard-domain matching lowercases/normalizes the
/// domain segment, but exact/specific-path comparisons fall back to raw
/// string equality with no normalization. This port preserves that exactly
/// rather than "fixing" it, since fixing it would silently diverge from
/// what the Python backend actually enforces.
/// </summary>
public static class ScopeMatcher
{
    private const string DynamicScopePrefix = "attr.";

    public static bool IsDynamicScope(string scope) =>
        scope.StartsWith(DynamicScopePrefix, StringComparison.Ordinal);

    /// <summary>
    /// Parses an attr.* scope into (domain, path, isWildcard). Domain and
    /// path are null when the scope isn't a well-formed attr.* scope or has
    /// no sub-path component (domain-level scope).
    /// </summary>
    public static (string? Domain, string? Path, bool IsWildcard) ParseScope(string scope)
    {
        if (!scope.StartsWith(DynamicScopePrefix, StringComparison.Ordinal))
            return (null, null, false);

        string remainder = scope[DynamicScopePrefix.Length..].Trim();
        if (remainder.Length == 0)
            return (null, null, false);

        string[] parts = remainder.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
            return (null, null, false);

        string domain = NormalizeDomainKey(parts[0]);
        if (domain.Length == 0)
            return (null, null, false);

        if (parts.Length == 1)
            return (domain, null, false);

        if (parts[^1] == "*")
        {
            if (parts.Length == 2)
                return (domain, null, true);

            string wildcardPath = NormalizeScopePath(string.Join('.', parts[1..^1]));
            return (domain, wildcardPath.Length == 0 ? null : wildcardPath, true);
        }

        string path = NormalizeScopePath(string.Join('.', parts[1..]));
        return (domain, path.Length == 0 ? null : path, false);
    }

    /// <summary>Does <paramref name="scope"/> fall under <paramref name="wildcard"/>?</summary>
    public static bool MatchesWildcard(string scope, string wildcard)
    {
        var (grantedDomain, grantedPath, grantedIsWildcard) = ParseScope(wildcard);
        var (requestedDomain, requestedPath, _) = ParseScope(scope);

        if (grantedDomain is null || requestedDomain is null)
            return scope == wildcard;
        if (grantedDomain != requestedDomain)
            return false;

        if (!grantedIsWildcard)
            return scope == wildcard;

        // attr.{domain}.* grants everything under that domain.
        if (grantedPath is null)
            return true;

        // attr.{domain}.{subintent}.* grants everything under that subintent path.
        if (requestedPath is null)
            return false;

        return requestedPath == grantedPath || requestedPath.StartsWith(grantedPath + ".", StringComparison.Ordinal);
    }

    /// <summary>Does <paramref name="grantedScope"/> (from a token) satisfy <paramref name="requestedScope"/> (an operation's requirement)?</summary>
    public static bool Matches(string grantedScope, string requestedScope)
    {
        if (grantedScope == requestedScope) return true;
        if (grantedScope == "vault.owner") return true;
        if (grantedScope == "pkm.read" && IsDynamicScope(requestedScope)) return true;
        if (IsDynamicScope(grantedScope) && IsDynamicScope(requestedScope))
            return MatchesWildcard(requestedScope, grantedScope);
        return false;
    }

    private static string NormalizeDomainKey(string domain) => domain.Trim().ToLowerInvariant();

    private static string NormalizeScopePath(string path)
    {
        string raw = path.Trim().ToLowerInvariant();
        if (raw.Length == 0) return "";

        var segments = new List<string>();
        foreach (string part in raw.Split('.'))
        {
            var sb = new StringBuilder();
            foreach (char ch in part.Trim())
            {
                sb.Append(char.IsLetterOrDigit(ch) || ch == '_' ? ch : '_');
            }
            string normalized = sb.ToString().Trim('_');
            if (normalized.Length > 0)
                segments.Add(normalized);
        }
        return string.Join('.', segments);
    }
}
