#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$MenuText)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Open Bridge Explorer integration is available only on Windows." }
$packageRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).ProviderPath
$entry = Join-Path $packageRoot "bin\open-bridge.js"
if ($MenuText) { $env:OPEN_BRIDGE_EXPLORER_MENU_TEXT = $MenuText }
$args = @($entry, "explorer", "install")
if ($WhatIfPreference) { $args += "--dry-run" }
& node.exe @args
exit $LASTEXITCODE
