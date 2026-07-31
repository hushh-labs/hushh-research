using System.Text.Json;
using OneWindows.Mcp;
using OneWindows.Npu;

namespace OneWindows.Daemon.Tools;

/// <summary>
/// Real NPU-backed capability: classifies a local image file with Qualcomm's
/// MobileNetV2, via ONNX Runtime's QNN execution provider targeting the
/// Hexagon NPU. See OneWindows.Npu.MobileNetClassifier for how NPU
/// execution is actually verified (not just attempted). No RequiredScope --
/// this doesn't touch vault/PKM data, same trust level as daemon.status.
/// </summary>
public sealed class ClassifyImageTool : IMcpTool
{
    private readonly MobileNetClassifier _classifier;

    public ClassifyImageTool(MobileNetClassifier classifier)
    {
        _classifier = classifier;
    }

    public ToolDefinition Definition { get; } = new(
        "daemon.classify_image",
        "Classifies a local image file (1000 ImageNet categories) using the Hexagon NPU when available.",
        new
        {
            type = "object",
            properties = new
            {
                imagePath = new { type = "string", description = "Absolute path to a local image file (jpg/png/bmp)." },
                topK = new { type = "integer", description = "Number of top predictions to return (default 5).", minimum = 1, maximum = 20 },
            },
            required = new[] { "imagePath" },
            additionalProperties = false,
        });

    public Task<McpToolResult> InvokeAsync(JsonElement? arguments, McpRequestContext context, CancellationToken cancellationToken)
    {
        if (arguments is not { ValueKind: JsonValueKind.Object } args ||
            !args.TryGetProperty("imagePath", out var pathElement) ||
            pathElement.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(pathElement.GetString()))
        {
            return Task.FromResult(McpToolResult.Text("Missing required string argument 'imagePath'.", isError: true));
        }

        string imagePath = pathElement.GetString()!;
        int topK = args.TryGetProperty("topK", out var topKElement) && topKElement.ValueKind == JsonValueKind.Number
            ? Math.Clamp(topKElement.GetInt32(), 1, 20)
            : 5;

        if (!File.Exists(imagePath))
            return Task.FromResult(McpToolResult.Text($"Image not found: {imagePath}", isError: true));

        try
        {
            var results = _classifier.Classify(imagePath, topK);
            string payload = JsonSerializer.Serialize(new
            {
                npuMode = _classifier.NpuMode.ToString(),
                predictions = results.Select(r => new { label = r.Label, confidence = r.Confidence }),
            });
            return Task.FromResult(McpToolResult.Text(payload));
        }
        catch (Exception ex)
        {
            return Task.FromResult(McpToolResult.Text($"Classification failed: {ex.Message}", isError: true));
        }
    }
}
