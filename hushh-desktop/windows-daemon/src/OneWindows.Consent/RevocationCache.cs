namespace OneWindows.Consent;

/// <summary>
/// C# port of hushh_mcp/consent/token.py's _BoundedRevocationCache: an
/// in-memory, thread-safe revocation set with expiry-based eviction.
/// Entries are kept until one hour after the token's own embedded expiry --
/// since TokenCodec.Validate rejects expired tokens anyway, dropping expired
/// revocation markers can't make an expired token usable again. Unexpired
/// revocations are never evicted for size pressure; local revocation must
/// stay strict even if a cross-instance store is temporarily unavailable.
///
/// Unlike Python's module-level `_revoked_tokens` singleton, this is a
/// plain instantiable class here, not a hidden static one baked into
/// TokenCodec -- TokenCodec.Validate takes an optional RevocationCache
/// parameter instead, so the library stays pure/stateless by default and
/// the host (OneWindows.Daemon) owns the one process-wide instance that
/// actually matches Python's real usage pattern.
/// </summary>
public sealed class RevocationCache
{
    private const long ExpiredTokenGraceMs = 60 * 60 * 1000; // 1 hour
    private readonly long _malformedTokenTtlMs;
    private const int MaxSize = 100_000;

    private readonly Dictionary<string, long> _entries = new();
    private readonly object _lock = new();

    public RevocationCache(long defaultExpiryMs = TokenCodec.DefaultExpiryMs)
    {
        _malformedTokenTtlMs = defaultExpiryMs + ExpiredTokenGraceMs;
    }

    public void Add(string tokenStr)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (_lock)
        {
            EvictExpiredLocked(nowMs);
            // Python logs a warning here at capacity rather than refusing the
            // write; unexpired revocations must never be dropped for size
            // pressure, so this port matches that (no eviction-on-overflow).
            _entries[tokenStr] = EvictAfterMs(tokenStr, nowMs);
        }
    }

    public bool Contains(string tokenStr)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (_lock)
        {
            if (!_entries.TryGetValue(tokenStr, out long evictAfterMs))
                return false;

            if (nowMs >= evictAfterMs)
            {
                _entries.Remove(tokenStr);
                return false;
            }

            return true;
        }
    }

    public int Count
    {
        get
        {
            lock (_lock) return _entries.Count;
        }
    }

    public void Clear()
    {
        lock (_lock) _entries.Clear();
    }

    private void EvictExpiredLocked(long nowMs)
    {
        List<string>? expired = null;
        foreach (var (key, evictAfterMs) in _entries)
        {
            if (evictAfterMs <= nowMs)
                (expired ??= new List<string>()).Add(key);
        }
        if (expired is null) return;
        foreach (string key in expired)
            _entries.Remove(key);
    }

    /// <summary>
    /// Mirrors _evict_after_ms(): parse the token's own embedded expires_at
    /// (parts[4] of the pipe-delimited payload) and add the grace period.
    /// Anything that fails to parse -- wrong prefix, bad base64, wrong field
    /// count -- falls back to now + a full default-expiry-plus-grace TTL,
    /// exactly like the Python source.
    /// </summary>
    internal long EvictAfterMs(string tokenStr, long nowMs)
    {
        try
        {
            string[] prefixParts = tokenStr.Split(':', 2);
            if (prefixParts.Length != 2) return nowMs + _malformedTokenTtlMs;

            string[] signedParts = prefixParts[1].Split('.', 2);
            if (signedParts.Length != 2) return nowMs + _malformedTokenTtlMs;

            string decoded = TokenCodec.Base64UrlDecode(signedParts[0]);
            string[] fields = decoded.Split('|');
            if (fields.Length is 5 or 6 && long.TryParse(fields[4], out long expiresAt))
                return expiresAt + ExpiredTokenGraceMs;
        }
        catch (FormatException)
        {
            // Bad base64 -- fall through to the malformed-token TTL below.
        }

        return nowMs + _malformedTokenTtlMs;
    }
}
