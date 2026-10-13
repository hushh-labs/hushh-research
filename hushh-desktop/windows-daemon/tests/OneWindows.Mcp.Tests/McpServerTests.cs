using System.Text.Json;
using OneWindows.Consent;

namespace OneWindows.Mcp.Tests;

public class McpServerTests
{
    private static readonly McpRequestContext Context = new(
        new ParsedConsentToken("user_1", "agent_test", "vault.owner", 0, long.MaxValue, "sig", Commercial: false));

    private static JsonElement Id(int value) => JsonSerializer.SerializeToElement(value);

    private static JsonElement? ParseParams(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    [Fact]
    public async Task Initialize_ReturnsProtocolVersionAndServerInfo()
    {
        var server = new McpServer(Array.Empty<IMcpTool>(), "one-windows-daemon", "0.1.0");
        var request = new JsonRpcRequest { Id = Id(1), Method = "initialize" };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.NotNull(response);
        Assert.Null(response!.Error);
        string json = JsonSerializer.Serialize(response.Result);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(McpServer.ProtocolVersion, doc.RootElement.GetProperty("protocolVersion").GetString());
        Assert.Equal("one-windows-daemon", doc.RootElement.GetProperty("serverInfo").GetProperty("name").GetString());
    }

    [Fact]
    public async Task NotificationsInitialized_ReturnsNullResponse()
    {
        var server = new McpServer(Array.Empty<IMcpTool>(), "one-windows-daemon", "0.1.0");
        var request = new JsonRpcRequest { Method = "notifications/initialized" };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.Null(response);
    }

    [Fact]
    public async Task ToolsList_ReturnsRegisteredTools()
    {
        var server = new McpServer(new IMcpTool[] { new FakeTool("alpha"), new FakeTool("beta") }, "d", "0.1.0");
        var request = new JsonRpcRequest { Id = Id(2), Method = "tools/list" };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        string json = JsonSerializer.Serialize(response!.Result);
        using var doc = JsonDocument.Parse(json);
        var names = doc.RootElement.GetProperty("tools").EnumerateArray()
            .Select(t => t.GetProperty("name").GetString())
            .ToArray();
        Assert.Equal(new[] { "alpha", "beta" }, names);
    }

    [Fact]
    public async Task ToolsCall_InvokesToolAndPassesCallerContext()
    {
        var server = new McpServer(new IMcpTool[] { new FakeTool("alpha") }, "d", "0.1.0");
        var request = new JsonRpcRequest
        {
            Id = Id(3),
            Method = "tools/call",
            Params = ParseParams("""{"name":"alpha","arguments":{}}"""),
        };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.Null(response!.Error);
        string json = JsonSerializer.Serialize(response.Result);
        using var doc = JsonDocument.Parse(json);
        string text = doc.RootElement.GetProperty("content")[0].GetProperty("text").GetString()!;
        Assert.Contains("user=user_1", text);
        Assert.False(doc.RootElement.GetProperty("isError").GetBoolean());
    }

    [Fact]
    public async Task ToolsCall_UnknownToolReturnsInvalidParamsError()
    {
        var server = new McpServer(Array.Empty<IMcpTool>(), "d", "0.1.0");
        var request = new JsonRpcRequest
        {
            Id = Id(4),
            Method = "tools/call",
            Params = ParseParams("""{"name":"does-not-exist"}"""),
        };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.NotNull(response!.Error);
        Assert.Equal(JsonRpcErrorCodes.InvalidParams, response.Error!.Code);
    }

    [Fact]
    public async Task ToolsCall_MissingNameReturnsInvalidParamsError()
    {
        var server = new McpServer(Array.Empty<IMcpTool>(), "d", "0.1.0");
        var request = new JsonRpcRequest { Id = Id(5), Method = "tools/call", Params = ParseParams("{}") };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.NotNull(response!.Error);
        Assert.Equal(JsonRpcErrorCodes.InvalidParams, response.Error!.Code);
    }

    [Fact]
    public async Task UnknownMethod_ReturnsMethodNotFoundError()
    {
        var server = new McpServer(Array.Empty<IMcpTool>(), "d", "0.1.0");
        var request = new JsonRpcRequest { Id = Id(6), Method = "totally/bogus" };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.NotNull(response!.Error);
        Assert.Equal(JsonRpcErrorCodes.MethodNotFound, response.Error!.Code);
    }

    [Fact]
    public async Task ToolsCall_CallerWithSufficientScope_InvokesGatedTool()
    {
        // vault.owner (Context's token scope) satisfies any RequiredScope via ScopeMatcher.
        var tool = new FakeTool("gated", requiredScope: "attr.financial.holdings");
        var server = new McpServer(new IMcpTool[] { tool }, "d", "0.1.0");
        var request = new JsonRpcRequest { Id = Id(8), Method = "tools/call", Params = ParseParams("""{"name":"gated"}""") };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.Null(response!.Error);
    }

    [Fact]
    public async Task ToolsCall_CallerWithInsufficientScope_RejectsWithoutInvokingTool()
    {
        bool invoked = false;
        var tool = new FakeTool("gated", (_, _) => { invoked = true; return McpToolResult.Text("should not run"); }, requiredScope: "agent.kai.execute");
        var narrowScopeContext = new McpRequestContext(
            new ParsedConsentToken("user_1", "agent_test", "agent.kai.chat", 0, long.MaxValue, "sig", Commercial: false));
        var server = new McpServer(new IMcpTool[] { tool }, "d", "0.1.0");
        var request = new JsonRpcRequest { Id = Id(9), Method = "tools/call", Params = ParseParams("""{"name":"gated"}""") };

        var response = await server.HandleAsync(request, narrowScopeContext, CancellationToken.None);

        Assert.False(invoked);
        Assert.NotNull(response!.Error);
        Assert.Equal(JsonRpcErrorCodes.InsufficientScope, response.Error!.Code);
    }

    [Fact]
    public async Task ToolsCall_ToolExceptionBecomesInternalErrorResponse_NotThrown()
    {
        var throwingTool = new FakeTool("boom", (_, _) => throw new InvalidOperationException("kaboom"));
        var server = new McpServer(new IMcpTool[] { throwingTool }, "d", "0.1.0");
        var request = new JsonRpcRequest
        {
            Id = Id(7),
            Method = "tools/call",
            Params = ParseParams("""{"name":"boom"}"""),
        };

        var response = await server.HandleAsync(request, Context, CancellationToken.None);

        Assert.NotNull(response!.Error);
        Assert.Equal(JsonRpcErrorCodes.InternalError, response.Error!.Code);
        Assert.Contains("kaboom", response.Error.Message);
    }
}
