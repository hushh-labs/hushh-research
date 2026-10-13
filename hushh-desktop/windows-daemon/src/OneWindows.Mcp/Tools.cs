using System.Text.Json;
using OneWindows.Consent;

namespace OneWindows.Mcp;

/// <summary>
/// RequiredScope is null when any authenticated caller may invoke the tool
/// (e.g. diagnostics like daemon.status). When set, McpServer checks it via
/// ScopeMatcher.Matches(callerToken.Scope, RequiredScope) before invoking --
/// tools never need to check this themselves.
/// </summary>
public sealed record ToolDefinition(string Name, string Description, object InputSchema, string? RequiredScope = null);

public sealed record McpContentBlock(string Type, string Text);

public sealed record McpToolResult(IReadOnlyList<McpContentBlock> Content, bool IsError)
{
    public static McpToolResult Text(string text, bool isError = false) =>
        new(new[] { new McpContentBlock("text", text) }, isError);
}

/// <summary>
/// Per-call context handed to tools. Carries the caller's already-validated
/// consent token -- tools trust it unconditionally since McpServer only
/// invokes them after TokenCodec.Validate succeeded upstream.
/// </summary>
public sealed record McpRequestContext(ParsedConsentToken CallerToken);

public interface IMcpTool
{
    ToolDefinition Definition { get; }

    Task<McpToolResult> InvokeAsync(JsonElement? arguments, McpRequestContext context, CancellationToken cancellationToken);
}
