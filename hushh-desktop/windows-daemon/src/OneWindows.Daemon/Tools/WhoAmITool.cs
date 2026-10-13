using System.Text.Json;
using OneWindows.Mcp;

namespace OneWindows.Daemon.Tools;

/// <summary>
/// Echoes back the identity/scope decoded from the caller's own bearer
/// token. Exists to prove, over a real HTTP round trip (not just a unit
/// test), that TokenCodec validation and the auth middleware actually wire
/// together correctly end to end.
/// </summary>
public sealed class WhoAmITool : IMcpTool
{
    public ToolDefinition Definition { get; } = new(
        "daemon.whoami",
        "Returns the identity and scope decoded from the caller's HCT bearer token.",
        new { type = "object", properties = new { }, additionalProperties = false });

    public Task<McpToolResult> InvokeAsync(JsonElement? arguments, McpRequestContext context, CancellationToken cancellationToken)
    {
        var token = context.CallerToken;
        string payload = JsonSerializer.Serialize(new
        {
            userId = token.UserId,
            agentId = token.AgentId,
            scope = token.Scope,
            commercial = token.Commercial,
            expiresAt = token.ExpiresAt,
        });

        return Task.FromResult(McpToolResult.Text(payload));
    }
}
