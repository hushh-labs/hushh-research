using System.Net;
using System.Text.Json;
using OneWindows.Consent;
using OneWindows.Daemon;
using OneWindows.Daemon.Tools;
using OneWindows.Mcp;
using OneWindows.Npu;

// Loopback-only MCP daemon: mirrors the Mac OneDaemon reference's threat
// model (background service, MCP server bound to 127.0.0.1 only, gated by
// a per-agent bearer token) rather than the stubbed-out shape that
// reference implementation currently ships. Never bind 0.0.0.0 here --
// that would turn a local trust boundary into a network-exposed one.
const int McpPort = 31070;

// Windows Services have no console -- Console.WriteLine goes nowhere once
// SCM launches this outside a session. File-based startup logging is the
// only way to see where a service-mode failure actually happens (as
// opposed to interactive `dotnet run`, which showed everything fine).
string logPath = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    "OneWindowsDaemon", "daemon.log");

void Log(string message)
{
    try
    {
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
        File.AppendAllText(logPath, $"{DateTimeOffset.UtcNow:O} {message}{Environment.NewLine}");
    }
    catch
    {
        // Logging must never itself take down startup.
    }
}

Log("Startup: begin");

DateTimeOffset startedAt = DateTimeOffset.UtcNow;

string signingKey;
try
{
    signingKey = SigningKeyLocator.Resolve();
    Log("Startup: signing key resolved");
}
catch (InvalidOperationException ex)
{
    Log($"Startup FAILED resolving signing key: {ex.Message}");
    Console.Error.WriteLine($"[OneWindows.Daemon] Startup failed: {ex.Message}");
    Environment.Exit(1);
    return;
}

var builder = WebApplication.CreateBuilder(args);
Log("Startup: WebApplication.CreateBuilder done");

builder.Host.UseWindowsService(options => options.ServiceName = "OneWindowsDaemon");
Log("Startup: UseWindowsService configured");

builder.WebHost.ConfigureKestrel(options =>
{
    options.Listen(IPAddress.Loopback, McpPort);
});
Log($"Startup: Kestrel configured for 127.0.0.1:{McpPort}");

// One process-wide instance, matching Python's module-level `_revoked_tokens`
// singleton usage. In-process only: nothing currently populates this from
// the Python backend's own DB-backed revocation (validate_token_with_db's
// cross-instance check isn't ported), so a token revoked there won't be
// rejected here until that sync exists. Real today for anything that calls
// .Add() within this process, including the daemon.revoke_token tool below.
var revocationCache = new RevocationCache();

// Best-effort, like the Windows Service host itself never being a hard
// requirement for this daemon to be useful: if the model hasn't been
// fetched (scripts/fetch-npu-model.ps1), skip registering the tool rather
// than failing startup. MobileNetClassifier.Load() takes real seconds
// (Hexagon graph compilation) -- done once here, not per-request.
var tools = new List<IMcpTool> { new DaemonStatusTool(startedAt), new WhoAmITool(), new RevokeTokenTool(revocationCache) };
string modelDir = Path.Combine(AppContext.BaseDirectory, "models", "mobilenet_v2");
if (File.Exists(Path.Combine(modelDir, "mobilenet_v2.onnx")))
{
    try
    {
        var classifier = MobileNetClassifier.Load(modelDir);
        Log($"Startup: MobileNetClassifier loaded, NpuMode={classifier.NpuMode}");
        tools.Add(new ClassifyImageTool(classifier));
    }
    catch (Exception ex)
    {
        Log($"Startup: MobileNetClassifier failed to load, daemon.classify_image will be unavailable: {ex.Message}");
    }
}
else
{
    Log($"Startup: no model at {modelDir}, daemon.classify_image will be unavailable. Run scripts/fetch-npu-model.ps1.");
}

var mcpServer = new McpServer(
    tools: tools,
    serverName: "one-windows-daemon",
    serverVersion: typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.1.0");

var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

WebApplication app;
try
{
    app = builder.Build();
    Log("Startup: builder.Build() done");
}
catch (Exception ex)
{
    Log($"Startup FAILED in builder.Build(): {ex}");
    throw;
}

app.MapGet("/health", () => Results.Json(new { status = "ok" }));

app.MapPost("/mcp", async (HttpContext http) =>
{
    if (!http.Request.Headers.TryGetValue("Authorization", out var authHeader) ||
        !authHeader.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
    {
        http.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await http.Response.WriteAsJsonAsync(new { error = "Missing or malformed Authorization header; expected 'Bearer <HCT token>'." });
        return;
    }

    string tokenStr = authHeader.ToString()["Bearer ".Length..].Trim();
    TokenValidationResult validation = TokenCodec.Validate(tokenStr, signingKey, revocationCache: revocationCache);
    if (!validation.IsValid)
    {
        http.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await http.Response.WriteAsJsonAsync(new { error = validation.Reason });
        return;
    }

    JsonRpcRequest? rpcRequest;
    try
    {
        rpcRequest = await JsonSerializer.DeserializeAsync<JsonRpcRequest>(http.Request.Body, jsonOptions, http.RequestAborted);
    }
    catch (JsonException)
    {
        http.Response.StatusCode = StatusCodes.Status400BadRequest;
        await http.Response.WriteAsJsonAsync(new { error = "Invalid JSON-RPC payload." });
        return;
    }

    if (rpcRequest is null)
    {
        http.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var mcpContext = new McpRequestContext(validation.Token!);
    JsonRpcResponse? response = await mcpServer.HandleAsync(rpcRequest, mcpContext, http.RequestAborted);

    if (response is null)
    {
        // Notification (e.g. notifications/initialized): no response body per JSON-RPC 2.0.
        http.Response.StatusCode = StatusCodes.Status202Accepted;
        return;
    }

    http.Response.ContentType = "application/json";
    await JsonSerializer.SerializeAsync(http.Response.Body, response, jsonOptions, http.RequestAborted);
});

// WindowsServiceLifetime reports SERVICE_RUNNING to SCM when this fires --
// if it never fires, SCM eventually times out the start request. This is
// the single most useful checkpoint for diagnosing a service-mode hang.
app.Lifetime.ApplicationStarted.Register(() => Log("Startup: ApplicationStarted fired -- SCM should see RUNNING now"));
app.Lifetime.ApplicationStopping.Register(() => Log("Shutdown: ApplicationStopping fired"));

Console.WriteLine($"[OneWindows.Daemon] Listening on http://127.0.0.1:{McpPort}/mcp (loopback only).");
Log("Startup: calling app.Run()");

try
{
    app.Run();
}
catch (Exception ex)
{
    Log($"FATAL during app.Run(): {ex}");
    throw;
}

Log("Startup: app.Run() returned, process exiting normally");
