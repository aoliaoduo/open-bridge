#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Open Bridge Explorer integration is available only on Windows." }
$workspace = (Resolve-Path -LiteralPath $Path).ProviderPath
if (-not $PSCmdlet.ShouldProcess($workspace, "Launch Open Bridge through the Node/TypeScript Windows adapter")) { return }
$packageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).ProviderPath
$entry = Join-Path $packageRoot "bin\open-bridge.js"
$env:OPEN_BRIDGE_EXPLORER_WORKSPACE = $workspace
& node.exe $entry "windows-launch" "explorer"
exit $LASTEXITCODE
