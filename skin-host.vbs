' Silent launcher for skin-host.ps1, used by the scheduled task "Codex Skin Host".
' wscript.exe is a GUI-subsystem program, so powershell starts with no console window.
Option Explicit

Dim fso, shell, here, hostScript, psExe, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
hostScript = fso.BuildPath(here, "skin-host.ps1")
If Not fso.FileExists(hostScript) Then WScript.Quit 2

psExe = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & hostScript & """ -Watch"
' 0 = hidden window, False = do not wait
shell.Run command, 0, False
