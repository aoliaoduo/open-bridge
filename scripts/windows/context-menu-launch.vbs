Option Explicit

' Explorer enters through this GUI-subsystem relay so no console flashes before
' Windows Terminal opens. Workspace data is carried in the child environment,
' never interpolated into a PowerShell/cmd program or native command string.

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

Dim fso, shell, processEnv, scriptDir, packageRoot, workspace, command, exitCode
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set processEnv = shell.Environment("PROCESS")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
packageRoot = fso.GetParentFolderName(fso.GetParentFolderName(scriptDir))
workspace = WScript.Arguments(0)
processEnv("OPEN_BRIDGE_EXPLORER_WORKSPACE") = workspace
shell.CurrentDirectory = packageRoot

' The command is deliberately fixed ASCII. Neither the selected workspace nor
' the package path is serialized into command text; cwd + environment carry data.
command = "node.exe bin\open-bridge.js windows-launch explorer"
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  MsgBox "Open Bridge failed to launch. Reinstall the Explorer integration or run open-bridge from a terminal for details.", 16, "Open Bridge"
End If
