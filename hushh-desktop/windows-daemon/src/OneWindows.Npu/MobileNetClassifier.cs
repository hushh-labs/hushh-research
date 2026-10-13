using System.Drawing;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace OneWindows.Npu;

public sealed record ClassificationResult(string Label, float Confidence);

/// <summary>
/// FullNpu: every graph node placed on the QNN HTP backend (verified via
/// disable_cpu_ep_fallback -- session creation would have thrown otherwise).
/// PartialNpu: QNN EP loaded and placed the compute-heavy majority of nodes
/// (Conv/Clip/Add -- the actual convolution backbone) on HTP, but a small
/// number of boundary ops (seen in testing: a lone Gemm/ReduceMean/Sub/Div
/// near the classifier head) fell back to CPU EP within the same session --
/// a normal, common outcome for real QNN deployments, not a failure.
/// CpuOnly: QNN EP unavailable entirely (no NPU/driver), or QNN EP rejected
/// the graph outright.
/// </summary>
public enum NpuExecutionMode
{
    FullNpu,
    PartialNpu,
    CpuOnly,
}

/// <summary>
/// Runs Qualcomm's official w8a16-quantized MobileNetV2 (see
/// scripts/fetch-npu-model.ps1) through ONNX Runtime's QNN execution
/// provider, targeting the Hexagon NPU on Snapdragon X hardware.
///
/// Proof of real NPU execution: session creation is attempted with
/// `session.disable_cpu_ep_fallback = "1"`, which makes ONNX Runtime throw
/// if even one graph node can't be placed on the QNN HTP backend. Per-node
/// EP assignment isn't otherwise queryable from the C# API, so a
/// successful session under that flag is the only unambiguous signal that
/// the *entire* model ran on the NPU, not a silent CPU fallback. If it
/// throws (no NPU present, or an unsupported op), this falls back to a
/// plain CPU session and reports RanOnNpu = false rather than failing --
/// still usable on non-Snapdragon hardware, just not NPU-accelerated there.
/// </summary>
public sealed class MobileNetClassifier : IDisposable
{
    private const int InputSize = 224;

    // Copied verbatim from the model's own metadata.json (Qualcomm AI Hub's
    // export), not computed here.
    private const float InputScale = 0.000015259021893143654f;
    private const int InputZeroPoint = 0;
    private const float OutputScale = 0.0007116134511306882f;
    private const int OutputZeroPoint = 16798;

    private readonly InferenceSession _session;
    private readonly string[] _labels;

    public NpuExecutionMode NpuMode { get; }
    public bool RanOnNpu => NpuMode != NpuExecutionMode.CpuOnly;

    private MobileNetClassifier(InferenceSession session, string[] labels, NpuExecutionMode npuMode)
    {
        _session = session;
        _labels = labels;
        NpuMode = npuMode;
    }

    /// <summary>modelDir must contain mobilenet_v2.onnx, mobilenet_v2.data, and labels.txt.</summary>
    public static MobileNetClassifier Load(string modelDir)
    {
        string modelPath = Path.Combine(modelDir, "mobilenet_v2.onnx");
        string labelsPath = Path.Combine(modelDir, "labels.txt");
        if (!File.Exists(modelPath))
            throw new FileNotFoundException($"Model not found at {modelPath}. Run scripts/fetch-npu-model.ps1 first.", modelPath);

        string[] labels = File.ReadAllLines(labelsPath);

        // Tier 1: strict -- every node must land on HTP or this throws.
        try
        {
            var strictOptions = new SessionOptions();
            strictOptions.AppendExecutionProvider("QNN", new Dictionary<string, string> { ["backend_path"] = "QnnHtp.dll" });
            strictOptions.AddSessionConfigEntry("session.disable_cpu_ep_fallback", "1");
            var fullNpuSession = new InferenceSession(modelPath, strictOptions);
            return new MobileNetClassifier(fullNpuSession, labels, NpuExecutionMode.FullNpu);
        }
        catch (OnnxRuntimeException)
        {
            // Fall through to tier 2.
        }

        // Tier 2: QNN EP registered, but let ORT fall back to CPU EP per-node
        // for whatever QNN can't place -- most real QNN deployments end up
        // here rather than at tier 1 (see NpuExecutionMode docs).
        try
        {
            var partialOptions = new SessionOptions();
            partialOptions.AppendExecutionProvider("QNN", new Dictionary<string, string> { ["backend_path"] = "QnnHtp.dll" });
            var partialNpuSession = new InferenceSession(modelPath, partialOptions);
            return new MobileNetClassifier(partialNpuSession, labels, NpuExecutionMode.PartialNpu);
        }
        catch (OnnxRuntimeException)
        {
            // Fall through to tier 3.
        }

        // Tier 3: no usable NPU path at all (no Snapdragon NPU/driver, or QNN
        // rejected the graph entirely) -- still usable, just not accelerated.
        var cpuSession = new InferenceSession(modelPath);
        return new MobileNetClassifier(cpuSession, labels, NpuExecutionMode.CpuOnly);
    }

    public IReadOnlyList<ClassificationResult> Classify(string imagePath, int topK = 5)
    {
        DenseTensor<ushort> inputTensor = PreprocessImage(imagePath);
        var inputs = new List<NamedOnnxValue> { NamedOnnxValue.CreateFromTensor("image_tensor", inputTensor) };

        using IDisposableReadOnlyCollection<DisposableNamedOnnxValue> results = _session.Run(inputs);
        ushort[] quantizedLogits = results.First(r => r.Name == "class_logits").AsTensor<ushort>().ToArray();

        float[] logits = new float[quantizedLogits.Length];
        for (int i = 0; i < quantizedLogits.Length; i++)
            logits[i] = (quantizedLogits[i] - OutputZeroPoint) * OutputScale;

        float[] probabilities = Softmax(logits);

        return probabilities
            .Select((p, i) => (Label: _labels[i], Confidence: p))
            .OrderByDescending(x => x.Confidence)
            .Take(topK)
            .Select(x => new ClassificationResult(x.Label, x.Confidence))
            .ToList();
    }

    /// <summary>
    /// Direct resize to 224x224 (no crop) via GDI+ Bitmap.GetPixel -- simple
    /// and correct over fast; a 224x224 image is ~50k pixels, well under a
    /// second even at GetPixel's known-slow per-call overhead. Not the
    /// path to optimize for a proof-of-execution tool.
    /// </summary>
    private static DenseTensor<ushort> PreprocessImage(string imagePath)
    {
        using var original = new Bitmap(imagePath);
        using var resized = new Bitmap(original, new Size(InputSize, InputSize));

        var tensor = new DenseTensor<ushort>(new[] { 1, 3, InputSize, InputSize });
        for (int y = 0; y < InputSize; y++)
        {
            for (int x = 0; x < InputSize; x++)
            {
                Color pixel = resized.GetPixel(x, y);
                tensor[0, 0, y, x] = QuantizePixel(pixel.R);
                tensor[0, 1, y, x] = QuantizePixel(pixel.G);
                tensor[0, 2, y, x] = QuantizePixel(pixel.B);
            }
        }
        return tensor;
    }

    private static ushort QuantizePixel(byte channelValue)
    {
        float normalized = channelValue / 255f;
        int quantized = (int)MathF.Round(normalized / InputScale) + InputZeroPoint;
        return (ushort)Math.Clamp(quantized, ushort.MinValue, ushort.MaxValue);
    }

    private static float[] Softmax(float[] logits)
    {
        float max = logits.Max();
        float[] exps = logits.Select(l => MathF.Exp(l - max)).ToArray();
        float sum = exps.Sum();
        return exps.Select(e => e / sum).ToArray();
    }

    public void Dispose() => _session.Dispose();
}
