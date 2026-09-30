Option Explicit

' Explorer invokes this GUI-subsystem relay so the short-lived PowerShell
' launcher never allocates a visible console window before Windows Terminal
' opens the real Open Bridge tab.

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

Dim fso, shell, scriptDir, launcher, workspace, command, exitCode
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(scriptDir, "context-menu-launch.ps1")
workspace = WScript.Arguments(0)

command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
  & QuoteArg(launcher) & " -Path " & QuoteArg(workspace)

' Window style 0 is hidden. PowerShell exits as soon as it hands the tab to
' Windows Terminal, so waiting here is short and lets us surface launch errors.
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  MsgBox "Open Bridge failed to launch. Reinstall the Explorer integration or run the launcher from a terminal for details.", 16, "Open Bridge"
End If

Function QuoteArg(value)
  QuoteArg = Chr(34) & value & Chr(34)
End Function
