using System.Text.Json;
using System.Text.Json.Serialization;

namespace OneWindows.Consent.Tests;

public sealed class GoldenVectorFile
{
    [JsonPropertyName("signingKey")]
    public string SigningKey { get; set; } = "";

    [JsonPropertyName("consentTokenPrefix")]
    public string ConsentTokenPrefix { get; set; } = "";

    [JsonPropertyName("cases")]
    public List<GoldenCase> Cases { get; set; } = new();

    [JsonPropertyName("malformedCases")]
    public List<MalformedCase> MalformedCases { get; set; } = new();

    [JsonPropertyName("gateCases")]
    public List<GateCase> GateCases { get; set; } = new();
}

public sealed class GateCase
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("token")]
    public string Token { get; set; } = "";

    [JsonPropertyName("expectedScope")]
    public string? ExpectedScope { get; set; }

    [JsonPropertyName("requireCommercial")]
    public bool? RequireCommercial { get; set; }

    [JsonPropertyName("expectedValid")]
    public bool ExpectedValid { get; set; }

    [JsonPropertyName("expectedReason")]
    public string? ExpectedReason { get; set; }

    public override string ToString() => Name;
}

public sealed class GoldenCase
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("input")]
    public GoldenCaseInput Input { get; set; } = new();

    [JsonPropertyName("expectedToken")]
    public string ExpectedToken { get; set; } = "";

    [JsonPropertyName("expectedSignature")]
    public string ExpectedSignature { get; set; } = "";

    [JsonPropertyName("expectedValid")]
    public bool ExpectedValid { get; set; }

    [JsonPropertyName("expectedReason")]
    public string? ExpectedReason { get; set; }

    public override string ToString() => Name;
}

public sealed class GoldenCaseInput
{
    [JsonPropertyName("userId")]
    public string UserId { get; set; } = "";

    [JsonPropertyName("agentId")]
    public string AgentId { get; set; } = "";

    [JsonPropertyName("scope")]
    public string Scope { get; set; } = "";

    [JsonPropertyName("issuedAt")]
    public long IssuedAt { get; set; }

    [JsonPropertyName("expiresAt")]
    public long ExpiresAt { get; set; }

    [JsonPropertyName("commercial")]
    public bool Commercial { get; set; }
}

public sealed class MalformedCase
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("rawToken")]
    public string RawToken { get; set; } = "";

    [JsonPropertyName("expectedValid")]
    public bool ExpectedValid { get; set; }

    [JsonPropertyName("expectedReasonContains")]
    public string ExpectedReasonContains { get; set; } = "";

    public override string ToString() => Name;
}

public static class GoldenVectorFixture
{
    private static readonly Lazy<GoldenVectorFile> _cached = new(Load);

    public static GoldenVectorFile Data => _cached.Value;

    private static GoldenVectorFile Load()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "fixtures", "hct_golden_vectors.json");
        string json = File.ReadAllText(path);
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<GoldenVectorFile>(json, options)
            ?? throw new InvalidOperationException($"Failed to deserialize golden vectors from {path}");
    }
}
