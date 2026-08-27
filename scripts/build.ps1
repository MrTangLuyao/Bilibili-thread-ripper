param(
  [string]$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist"))
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $distRoot "extension"))
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $distRoot "source-package"))
$privateRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "private"))
$keyPath = Join-Path $privateRoot "extension.pem"
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot "manifest.json") -Raw | ConvertFrom-Json
$version = [string]$manifest.version

if (-not $extensionRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "构建目录不在项目内，已停止。"
}

if (Test-Path -LiteralPath $distRoot) {
  Remove-Item -LiteralPath $distRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $extensionRoot | Out-Null
New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot "manifest.json") -Destination $extensionRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $extensionRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination $extensionRoot
foreach ($folder in @("src", "popup", "vendor", "pics")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $folder) -Destination $extensionRoot -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $extensionRoot "icons") | Out-Null
Copy-Item -Path (Join-Path $projectRoot "icons\*.png") -Destination (Join-Path $extensionRoot "icons")

$zipPath = Join-Path $distRoot "bilibili-thread-ripper-v$version.zip"
Compress-Archive -Path (Join-Path $extensionRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal

New-Item -ItemType Directory -Path $sourceRoot | Out-Null
foreach ($file in @("manifest.json", "README.md", "LICENSE")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $sourceRoot
}
foreach ($folder in @("src", "popup", "icons", "scripts", "vendor", "pics")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $folder) -Destination $sourceRoot -Recurse
}
$sourceZipPath = Join-Path $distRoot "Bilibili-线程撕裂者-v$version-source.zip"
Compress-Archive -Path (Join-Path $sourceRoot "*") -DestinationPath $sourceZipPath -CompressionLevel Optimal

if (Test-Path -LiteralPath $ChromePath) {
  $arguments = @("--pack-extension=$extensionRoot", "--no-message-box")
  if (Test-Path -LiteralPath $keyPath) {
    $arguments += "--pack-extension-key=$keyPath"
  }
  Start-Process -FilePath $ChromePath -ArgumentList $arguments -Wait -WindowStyle Hidden
  $generatedKey = Join-Path $distRoot "extension.pem"
  if (Test-Path -LiteralPath $generatedKey) {
    Move-Item -LiteralPath $generatedKey -Destination $keyPath -Force
  }
  Write-Output "CRX: $(Join-Path $distRoot 'extension.crx')"
  Write-Output "私钥（请勿公开）: $keyPath"
} else {
  Write-Warning "未找到 Chrome，只生成 ZIP。"
}

Write-Output "ZIP: $zipPath"
Write-Output "源码 ZIP: $sourceZipPath"
