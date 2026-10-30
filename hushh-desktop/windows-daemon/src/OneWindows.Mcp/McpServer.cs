using System.Text.Json;
using OneWindows.Consent;

namespace OneWindows.Mcp;

/// <summary>
/// Dispatches the MCP core methods (initialize, tools/list, tools/call) over
/// whatever JSON-RPC transport the host wires up. Deliberately stateless:
/// every request is authorized independently by the host (see
/// OneWindows.Daemon's bearer-token middleware) rather than gated on a
/// remembered "did this session call initialize" flag -- there is no
/// session store here, matching the Mac reference's simpler "gated by a
/// per-agent token" model rather than the full MCP OAuth+session spec.
///
/// Protocol subset implemented: initialize, notifications/initialized,
/// tools/list, tools/call. Resources/prompts are not implemented -- this
/// daemon exposes tools only, for now.
/// </summary>
public sealed class McpServer
{
    public const string ProtocolVersion = "2025-06-18";

    private readonly IReadOnlyDictionary<string, IMcpTool> _tools;
    private readonly string _serverName;
    private readonly string _serverVersion;

    public McpServer(IEnumerable<IMcpTool> tools, string serverName, string serverVersion)
    {
        _tools = tools.ToDictionary(t => t.Definition.Name);
        _serverName = serverName;
        _serverVersion = serverVersion;
    }

    /// <summary>Returns null for notifications, which expect no JSON-RPC response body.</summary>
    public async Task<JsonRpcResponse?> HandleAsync(JsonRpcRequest request, McpRequestContext context, CancellationToken cancellationToken)
    {
        switch (request.Method)
        {
            case "initialize":
                return JsonRpcResponse.Ok(request.Id, new
                {
                    protocolVersion = ProtocolVersion,
                    capabilities = new { tools = new { } },
                    serverInfo = new { name = _serverName, version = _serverVersion },
                });

            case "notifications/initialized":
                return null;

            case "tools/list":
                return JsonRpcResponse.Ok(request.Id, new
                {
                    tools = _tools.Values.Select(t => new
                    {
                        name = t.Definition.Name,
                        description = t.Definition.Description,
                        inputSchema = t.Definition.InputSchema,
                    }),
                });

            case "tools/call":
                return await HandleToolCallAsync(request, context, cancellationToken);

            default:
                if (request.IsNotification) return null;
                return JsonRpcResponse.Fail(request.Id, JsonRpcErrorCodes.MethodNotFound, $"Method not found: {request.Method}");
        }
    }

    private async Task<JsonRpcResponse?> HandleToolCallAsync(JsonRpcRequest request, McpRequestContext context, CancellationToken cancellationToken)
    {
        if (request.Params is not { ValueKind: JsonValueKind.Object } paramsElement ||
            !paramsElement.TryGetProperty("name", out var nameElement) ||
            nameElement.ValueKind != JsonValueKind.String)
        {
            return JsonRpcResponse.Fail(request.Id, JsonRpcErrorCodes.InvalidParams, "tools/call requires a string 'name' parameter.");
        }

        string toolName = nameElement.GetString()!;
        if (!_tools.TryGetValue(toolName, out var tool))
        {
            return JsonRpcResponse.Fail(request.Id, JsonRpcErrorCodes.InvalidParams, $"Unknown tool: {toolName}");
        }

        string? requiredScope = tool.Definition.RequiredScope;
        if (requiredScope is not null && !ScopeMatcher.Matches(context.CallerToken.Scope, requiredScope))
        {
            return JsonRpcResponse.Fail(
                request.Id,
                JsonRpcErrorCodes.InsufficientScope,
                $"Tool '{toolName}' requires scope '{requiredScope}', caller token has '{context.CallerToken.Scope}'.");
        }

        JsonElement? arguments = paramsElement.TryGetProperty("arguments", out var argsElement)
            ? argsElement
            : null;

        try
        {
            McpToolResult result = await tool.InvokeAsync(arguments, context, cancellationToken);
            return JsonRpcResponse.Ok(request.Id, new
            {
                content = result.Content.Select(c => new { type = c.Type, text = c.Text }),
                isError = result.IsError,
            });
        }
        catch (Exception ex)
        {
            return JsonRpcResponse.Fail(request.Id, JsonRpcErrorCodes.InternalError, $"Tool '{toolName}' threw: {ex.Message}");
        }
    }
}
