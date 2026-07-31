<#
.SYNOPSIS
Downloads Qualcomm's official MobileNetV2 model, pre-quantized (w8a16) for
the QNN HTP execution provider, into windows-daemon/models/mobilenet_v2/.

Source: https://huggingface.co/qualcomm/MobileNet-v2 (Apache 2.0, upstream
license at https://github.com/tonylins/pytorch-mobilenet-v2/blob/master/LICENSE).
Not committed to git (see .gitignore) -- same pattern as GenieX's own
models, which are pulled at setup time rather than checked in.
#>

$ErrorActionPreference = "Stop"

$ModelDir = Join-Path $PSScriptRoot "..\models\mobilenet_v2"
$Url = "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/mobilenet_v2/releases/v0.58.0/mobilenet_v2-onnx-w8a16.zip"
$ZipPath = Join-Path $env:TEMP "mobilenet_v2-onnx-w8a16.zip"

if (Test-Path (Join-Path $ModelDir "mobilenet_v2.onnx")) {
    Write-Host "Model already present at $ModelDir"
    exit 0
}

New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null

Write-Host "Downloading $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $ZipPath

Write-Host "Extracting to $ModelDir ..."
Expand-Archive -Path $ZipPath -DestinationPath $env:TEMP -Force
Copy-Item (Join-Path $env:TEMP "mobilenet_v2-onnx-w8a16\*") $ModelDir -Recurse -Force

Remove-Item $ZipPath -Force
Remove-Item (Join-Path $env:TEMP "mobilenet_v2-onnx-w8a16") -Recurse -Force

Write-Host "Done: $ModelDir"
