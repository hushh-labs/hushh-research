using System.Text.Json;
using OneWindows.Consent;
using OneWindows.Mcp;

namespace OneWindows.Daemon.Tools;

/// <summary>
/// Adds a token to the daemon's in-process RevocationCache. Gated behind
/// vault.owner -- Python's ConsentScope docs call that scope the "master
/// key," granted only via BYOK login and never handed to external agents,
/// so it's the appropriate bar for "may revoke arbitrary tokens" (an
/// unscoped revoke tool would let any authenticated caller invalidate any
/// other caller's token, which is a real if narrow trust violation even
/// though it can only degrade access, never escalate it).
///
/// In-process only, same caveat as RevocationCache itself: this does not
/// reach the Python backend's own DB-backed revocation store, so it can't
/// revoke a token as far as the backend is concerned -- only as far as
/// this daemon is concerned.
/// </summary>
public sealed class RevokeTokenTool : IMcpTool
{
    private readonly RevocationCache _revocationCache;

    public RevokeTokenTool(RevocationCache revocationCache)
    {
        _revocationCache = revocationCache;
    }

    public ToolDefinition Definition { get; } = new(
        "daemon.revoke_token",
        "Revokes an HCT token so this daemon rejects it on future requests. Requires vault.owner scope.",
        new
        {
            type = "object",
            properties = new { token = new { type = "string", description = "The full HCT token string to revoke." } },
            required = new[] { "token" },
            additionalProperties = false,
        },
        RequiredScope: "vault.owner");

    public Task<McpToolResult> InvokeAsync(JsonElement? arguments, McpRequestContext context, CancellationToken cancellationToken)
    {
        if (arguments is not { ValueKind: JsonValueKind.Object } args ||
            !args.TryGetProperty("token", out var tokenElement) ||
            tokenElement.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(tokenElement.GetString()))
        {
            return Task.FromResult(McpToolResult.Text("Missing required string argument 'token'.", isError: true));
        }

        string token = tokenElement.GetString()!;
        _revocationCache.Add(token);

        string payload = JsonSerializer.Serialize(new { revoked = true, revokedBy = context.CallerToken.UserId });
        return Task.FromResult(McpToolResult.Text(payload));
    }
}
