#requires -Version 5.1
<#
.SYNOPSIS
  Install the Open Bridge launcher into the current user's Explorer context menu.

.DESCRIPTION
  Writes only HKCU\Software\Classes; administrator privileges are not required.
  Two verbs are registered:
    - right-click a folder
    - right-click the background inside a folder

  Both call a windowless VBScript relay, which then runs context-menu-launch.ps1
  hidden. Re-running this script updates the existing registration, which is
  useful after moving a development checkout.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$MenuText = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($MenuText)) {
  # Keep the script source ASCII so Windows PowerShell 5.1 does not depend on a
  # UTF-8 BOM to decode the default Chinese label correctly.
  $MenuText = (-join ([char[]](0x5728, 0x6B64, 0x542F, 0x52A8))) + " Open Bridge"
}

if ($env:OS -ne "Windows_NT") {
  throw "Open Bridge Explorer integration is available only on Windows."
}

$launcher = Join-Path $PSScriptRoot "context-menu-launch.vbs"
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
  $command = 'wscript.exe "' +
    $launcher + '" "' + $placeholder + '"'

  if ($PSCmdlet.ShouldProcess($key, "Install Open Bridge Explorer verb for " + $entry.Description)) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $MenuText
    # Keep Open Bridge with the ordinary third-party/developer shell verbs
    # (for example VS Code / Terminal) instead of forcing it into a singleton
    # group at the very top of Explorer's classic context menu.
    Remove-ItemProperty -Path $key -Name "Position" -ErrorAction SilentlyContinue
    New-ItemProperty -Path $key -Name "SeparatorBefore" -Value "" -PropertyType String -Force | Out-Null
    New-Item -Path $commandKey -Force | Out-Null
    Set-Item -Path $commandKey -Value $command
  }
}

Write-Host "Open Bridge Explorer context menu installed for the current user."
Write-Host "Windows 11 may place classic shell verbs under 'Show more options'."
