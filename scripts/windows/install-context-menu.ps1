#requires -Version 5.1
<#
.SYNOPSIS
  Install "Open Bridge Here" into the current user's Explorer context menu.

.DESCRIPTION
  Writes only HKCU\Software\Classes; administrator privileges are not required.
  Two verbs are registered:
    - right-click a folder
    - right-click the background inside a folder

  Both call context-menu-launch.ps1. Re-running this script updates the existing
  registration, which is useful after moving a development checkout.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$MenuText = "Open Bridge Here"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "Open Bridge Explorer integration is available only on Windows."
}

$launcher = Join-Path $PSScriptRoot "context-menu-launch.ps1"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "Context-menu launcher is missing: $launcher"
}
$launcher = (Resolve-Path -LiteralPath $launcher).ProviderPath

$entries = @(
  @{
    Key = "HKCU:\Software\Classes\Directory\shell\OpenBridge"
    Placeholder = "%1"
    Description = "folder"
  },
  @{
    Key = "HKCU:\Software\Classes\Directory\Background\shell\OpenBridge"
    Placeholder = "%V"
    Description = "folder background"
  }
)

foreach ($entry in $entries) {
  $key = [string]$entry.Key
  $commandKey = Join-Path $key "command"
  $placeholder = [string]$entry.Placeholder
  $command = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' +
    $launcher + '" "' + $placeholder + '"'

  if ($PSCmdlet.ShouldProcess($key, "Install Open Bridge Explorer verb for " + $entry.Description)) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $MenuText
    New-ItemProperty -Path $key -Name "Position" -Value "Top" -PropertyType String -Force | Out-Null
    New-Item -Path $commandKey -Force | Out-Null
    Set-Item -Path $commandKey -Value $command
  }
}

Write-Host "Open Bridge Explorer context menu installed for the current user."
Write-Host "Windows 11 may place classic shell verbs under 'Show more options'."
