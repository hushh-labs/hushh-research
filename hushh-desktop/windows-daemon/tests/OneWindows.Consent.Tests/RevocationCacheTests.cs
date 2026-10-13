using System.Text.Json;
using System.Text.Json.Serialization;

namespace OneWindows.Consent.Tests;

public sealed class RevocationVectorFile
{
    [JsonPropertyName("nowMs")]
    public long NowMs { get; set; }

    [JsonPropertyName("cases")]
    public List<RevocationCase> Cases { get; set; } = new();
}

public sealed class RevocationCase
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("tokenStr")]
    public string TokenStr { get; set; } = "";

    [JsonPropertyName("expectedEvictAfterMs")]
    public long ExpectedEvictAfterMs { get; set; }

    public override string ToString() => Name;
}

public class RevocationCacheTests
{
    private static readonly Lazy<RevocationVectorFile> _fixture = new(Load);

    private static RevocationVectorFile Load()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "fixtures", "revocation_cache_golden_vectors.json");
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<RevocationVectorFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Failed to deserialize {path}");
    }

    public static IEnumerable<object[]> Cases() => _fixture.Value.Cases.Select(c => new object[] { c });

    [Theory]
    [MemberData(nameof(Cases))]
    public void EvictAfterMs_MatchesPython(RevocationCase testCase)
    {
        var cache = new RevocationCache();
        long actual = cache.EvictAfterMs(testCase.TokenStr, _fixture.Value.NowMs);
        Assert.Equal(testCase.ExpectedEvictAfterMs, actual);
    }

    [Fact]
    public void AddThenContains_ReturnsTrueForUnexpiredRevocation()
    {
        var cache = new RevocationCache();
        string token = TokenCodec.Issue("u", "a", "vault.owner", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), long.MaxValue / 2, false, "key").Token;

        Assert.False(cache.Contains(token));
        cache.Add(token);
        Assert.True(cache.Contains(token));
        Assert.Equal(1, cache.Count);
    }

    [Fact]
    public void Contains_ReturnsFalseAndEvictsAfterGracePeriodPasses()
    {
        var cache = new RevocationCache();
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Token already expired 2 hours ago -- grace period (1h) has also passed.
        string alreadyPastGrace = TokenCodec.Issue("u", "a", "vault.owner", nowMs - 3 * 60 * 60 * 1000, nowMs - 2 * 60 * 60 * 1000, false, "key").Token;

        cache.Add(alreadyPastGrace);
        Assert.False(cache.Contains(alreadyPastGrace));
        Assert.Equal(0, cache.Count); // lazily evicted by Contains()
    }

    [Fact]
    public void Clear_RemovesAllEntries()
    {
        var cache = new RevocationCache();
        cache.Add(TokenCodec.Issue("u1", "a", "vault.owner", 0, long.MaxValue / 2, false, "key").Token);
        cache.Add(TokenCodec.Issue("u2", "a", "vault.owner", 0, long.MaxValue / 2, false, "key").Token);
        Assert.Equal(2, cache.Count);

        cache.Clear();
        Assert.Equal(0, cache.Count);
    }

    [Fact]
    public void Validate_RejectsRevokedTokenBeforeAnyOtherCheck()
    {
        const string key = "test-signing-key-at-least-32-characters-long";
        string token = TokenCodec.Issue("u", "a", "vault.owner", key).Token;

        // Valid until revoked.
        Assert.True(TokenCodec.Validate(token, key).IsValid);

        var cache = new RevocationCache();
        cache.Add(token);

        var result = TokenCodec.Validate(token, key, revocationCache: cache);
        Assert.False(result.IsValid);
        Assert.Equal("Token has been revoked", result.Reason);
    }

    [Fact]
    public void Validate_WithoutRevocationCache_IgnoresRevocationEntirely()
    {
        const string key = "test-signing-key-at-least-32-characters-long";
        string token = TokenCodec.Issue("u", "a", "vault.owner", key).Token;

        var cache = new RevocationCache();
        cache.Add(token);

        // No cache passed -- default (null) skips revocation checking, matching
        // the documented opt-in behavior for callers that don't care.
        var result = TokenCodec.Validate(token, key);
        Assert.True(result.IsValid);
    }
}
