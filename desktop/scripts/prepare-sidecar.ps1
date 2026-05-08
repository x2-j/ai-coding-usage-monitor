$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root "src-tauri"
$binDir = Join-Path $tauri "bin"
$targetTriple = "x86_64-pc-windows-msvc"
$sidecarName = "statusline_capture-$targetTriple.exe"
$sidecarPath = Join-Path $binDir $sidecarName

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Tauri validates the externalBin path before Cargo builds the Rust sidecar.
# Put a placeholder in place first, then replace it with the compiled binary.
if (-not (Test-Path $sidecarPath)) {
  Set-Content -LiteralPath $sidecarPath -Value "placeholder" -Encoding ASCII
}

Push-Location $tauri
try {
  cargo build --release --bin statusline_capture
}
finally {
  Pop-Location
}

$built = Join-Path $tauri "target\release\statusline_capture.exe"
if (-not (Test-Path $built)) {
  throw "Expected sidecar was not built: $built"
}

Copy-Item -LiteralPath $built -Destination $sidecarPath -Force
Write-Host "Prepared sidecar: $sidecarPath"
