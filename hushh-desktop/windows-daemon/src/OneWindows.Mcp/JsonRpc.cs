using System.Text.Json;
using System.Text.Json.Serialization;

namespace OneWindows.Mcp;

/// <summary>Minimal JSON-RPC 2.0 envelope, sufficient for MCP's Streamable HTTP transport.</summary>
public sealed class JsonRpcRequest
{
    [JsonPropertyName("jsonrpc")]
    public string Jsonrpc { get; set; } = "2.0";

    /// <summary>JsonElement (not string/long) because JSON-RPC ids may be a string,
    /// number, or absent (notifications) -- we echo back whatever shape the caller sent.</summary>
    [JsonPropertyName("id")]
    public JsonElement? Id { get; set; }

    [JsonPropertyName("method")]
    public string Method { get; set; } = "";

    [JsonPropertyName("params")]
    public JsonElement? Params { get; set; }

    /// <summary>Notifications (e.g. notifications/initialized) carry no id and expect no response.</summary>
    public bool IsNotification => Id is null || Id.Value.ValueKind == JsonValueKind.Undefined;
}

public sealed class JsonRpcResponse
{
    [JsonPropertyName("jsonrpc")]
    public string Jsonrpc { get; set; } = "2.0";

    [JsonPropertyName("id")]
    public JsonElement? Id { get; set; }

    [JsonPropertyName("result")]
    public object? Result { get; set; }

    [JsonPropertyName("error")]
    public JsonRpcError? Error { get; set; }

    public static JsonRpcResponse Ok(JsonElement? id, object result) =>
        new() { Id = id, Result = result };

    public static JsonRpcResponse Fail(JsonElement? id, int code, string message, object? data = null) =>
        new() { Id = id, Error = new JsonRpcError { Code = code, Message = message, Data = data } };
}

public sealed class JsonRpcError
{
    [JsonPropertyName("code")]
    public int Code { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = "";

    [JsonPropertyName("data")]
    public object? Data { get; set; }
}

/// <summary>Standard JSON-RPC 2.0 error codes used by the dispatcher.</summary>
public static class JsonRpcErrorCodes
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;

    /// <summary>App-defined server error, in the -32000..-32099 range JSON-RPC 2.0 reserves for that purpose.</summary>
    public const int InsufficientScope = -32001;
}
