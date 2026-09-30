#requires -Version 5.1
<#
.SYNOPSIS
  Launch Open Bridge for one Explorer-selected workspace.

.DESCRIPTION
  This is the stable target stored in the Explorer context-menu registry keys.
  It opens a fresh terminal and runs "open-bridge launch --root <path>". The CLI,
  not this script, owns instance detection and the one-workspace-one-instance rule.

  Windows Terminal is preferred when available; Windows PowerShell is the
  dependency-free fallback. The command body is passed as -EncodedCommand so
  spaces, ampersands, Unicode and quotes in workspace paths do not become shell
  syntax.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "Open Bridge Explorer integration is available only on Windows."
}

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
  throw "Workspace directory does not exist: $Path"
}
$workspace = (Resolve-Path -LiteralPath $Path).ProviderPath

function ConvertTo-PowerShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

$workspaceLiteral = ConvertTo-PowerShellLiteral $workspace
$titleLiteral = ConvertTo-PowerShellLiteral ("Open Bridge - " + (Split-Path -Leaf $workspace))

$packageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).ProviderPath
$bridgeJs = Join-Path $packageRoot "bin\open-bridge.js"
$node = Get-Command "node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $node -and (Test-Path -LiteralPath $bridgeJs -PathType Leaf)) {
  # Prefer the CLI shipped beside this launcher so the registry entry and the
  # launch command can never drift across package versions.
  $bridgeInvoke = "& " + (ConvertTo-PowerShellLiteral $node.Source) + " " +
    (ConvertTo-PowerShellLiteral $bridgeJs) + " launch --root " + $workspaceLiteral
} else {
  $bridgeShim = Get-Command "open-bridge.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $bridgeShim) {
    throw "Cannot find this package's Node.js launcher or open-bridge.cmd. Install Open Bridge first."
  }
  $bridgeInvoke = "& " + (ConvertTo-PowerShellLiteral $bridgeShim.Source) + " launch --root " + $workspaceLiteral
}

$command = @"
try { `$Host.UI.RawUI.WindowTitle = $titleLiteral } catch {}
Set-Location -LiteralPath $workspaceLiteral
$bridgeInvoke
if (`$LASTEXITCODE -ne 0) {
  Write-Host ""
  Read-Host "Open Bridge failed. Press Enter to close" | Out-Null
}
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

$terminal = Get-Command "wt.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $terminal) {
  if ($PSCmdlet.ShouldProcess($workspace, "Open Windows Terminal tab and launch Open Bridge")) {
    Start-Process -FilePath $terminal.Source -ArgumentList @(
      "new-tab",
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-EncodedCommand",
      $encoded
    ) | Out-Null
  }
  return
}

if ($PSCmdlet.ShouldProcess($workspace, "Open Windows PowerShell and launch Open Bridge")) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoLogo",
    "-NoProfile",
    "-EncodedCommand",
    $encoded
  ) | Out-Null
}
