#requires -Version 5.1
<#
.SYNOPSIS
  Remove the current user's "Open Bridge Here" Explorer context-menu entries.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "Open Bridge Explorer integration is available only on Windows."
}

$keys = @(
  "HKCU:\Software\Classes\Directory\shell\OpenBridge",
  "HKCU:\Software\Classes\Directory\Background\shell\OpenBridge"
)

foreach ($key in $keys) {
  if (-not (Test-Path -LiteralPath $key)) {
    continue
  }
  if ($PSCmdlet.ShouldProcess($key, "Remove Open Bridge Explorer verb")) {
    Remove-Item -LiteralPath $key -Recurse -Force
  }
}

Write-Host "Open Bridge Explorer context menu removed for the current user."
