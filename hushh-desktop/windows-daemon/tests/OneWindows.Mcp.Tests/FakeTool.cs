using System.Text.Json;

namespace OneWindows.Mcp.Tests;

internal sealed class FakeTool : IMcpTool
{
    private readonly Func<JsonElement?, McpRequestContext, McpToolResult> _handler;

    public FakeTool(string name, Func<JsonElement?, McpRequestContext, McpToolResult>? handler = null, string? requiredScope = null)
    {
        Definition = new ToolDefinition(name, $"Fake tool '{name}' for tests.", new { type = "object" }, requiredScope);
        _handler = handler ?? ((_, ctx) => McpToolResult.Text($"hello from {name}, user={ctx.CallerToken.UserId}"));
    }

    public ToolDefinition Definition { get; }

    public Task<McpToolResult> InvokeAsync(JsonElement? arguments, McpRequestContext context, CancellationToken cancellationToken) =>
        Task.FromResult(_handler(arguments, context));
}
