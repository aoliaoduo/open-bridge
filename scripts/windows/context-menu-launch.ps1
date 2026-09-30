#requires -Version 5.1
<#
.SYNOPSIS
  Launch Open Bridge for one Explorer-selected workspace.

.DESCRIPTION
  This is the PowerShell implementation behind the windowless Explorer relay.
  It opens a fresh terminal and runs "open-bridge launch --root <path>". The CLI,
  not these launcher scripts, owns instance detection and the one-workspace-one-instance rule.

  Windows Terminal is preferred when available. Open Bridge itself is launched
  as the terminal tab's root process instead of through an intermediate shell,
  so closing the tab also terminates that workspace instance instead of leaving
  an orphaned Bridge behind.
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

$packageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).ProviderPath
$bridgeJs = Join-Path $packageRoot "bin\open-bridge.js"
$node = Get-Command "node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $node -or -not (Test-Path -LiteralPath $bridgeJs -PathType Leaf)) {
  throw "Cannot find Node.js or this package's bin/open-bridge.js. Install Open Bridge first."
}
$title = "Open Bridge - " + (Split-Path -Leaf $workspace)

$terminal = Get-Command "wt.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $terminal) {
  if ($PSCmdlet.ShouldProcess($workspace, "Open Windows Terminal tab and launch Open Bridge")) {
    $terminalArgs = @(
      "new-tab",
      "--title",
      $title,
      "--startingDirectory",
      $workspace,
      $node.Source,
      $bridgeJs,
      "launch",
      "--root",
      $workspace
    )
    & $terminal.Source @terminalArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Windows Terminal failed to open the Open Bridge workspace."
    }
  }
  return
}

if ($PSCmdlet.ShouldProcess($workspace, "Open a console and launch Open Bridge")) {
  # Start-Process opens console executables in a new window by default on
  # Windows. Quote the two path arguments explicitly because ArgumentList is
  # joined into one native command line by Windows PowerShell 5.1.
  $nodeArgs = '"' + $bridgeJs + '" launch --root "' + $workspace + '"'
  Start-Process -FilePath $node.Source -WorkingDirectory $workspace -ArgumentList $nodeArgs | Out-Null
}
