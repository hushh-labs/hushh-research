using System.Reflection;
using System.Text.Json;
using OneWindows.Mcp;

namespace OneWindows.Daemon.Tools;

/// <summary>Real liveness/version probe -- no scope requirements beyond a valid HCT bearer token.</summary>
public sealed class DaemonStatusTool : IMcpTool
{
    private readonly DateTimeOffset _startedAt;

    public DaemonStatusTool(DateTimeOffset startedAt)
    {
        _startedAt = startedAt;
    }

    public ToolDefinition Definition { get; } = new(
        "daemon.status",
        "Reports OneWindows daemon liveness, version, and uptime.",
        new { type = "object", properties = new { }, additionalProperties = false });

    public Task<McpToolResult> InvokeAsync(JsonElement? arguments, McpRequestContext context, CancellationToken cancellationToken)
    {
        var uptime = DateTimeOffset.UtcNow - _startedAt;
        string version = typeof(DaemonStatusTool).Assembly.GetName().Version?.ToString() ?? "0.0.0";

        string payload = JsonSerializer.Serialize(new
        {
            status = "ok",
            platform = "windows",
            version,
            uptimeSeconds = (long)uptime.TotalSeconds,
        });

        return Task.FromResult(McpToolResult.Text(payload));
    }
}
