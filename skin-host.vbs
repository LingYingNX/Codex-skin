' Silent launcher for skin-host.ps1, used by the scheduled task "Codex Skin Host".
' wscript.exe is a GUI-subsystem program, so powershell starts with no console window.
' Exits immediately when a host is already up (see the pid guard below).
Option Explicit

Dim fso, shell, here, hostScript, psExe, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
hostScript = fso.BuildPath(here, "skin-host.ps1")
If Not fso.FileExists(hostScript) Then WScript.Quit 2

' Guard: the live host holds skin-host.pid open with FileShare.None, so a
' failed open means "already running" - quit without starting powershell.exe.
Dim pidPath, probe, busy
pidPath = fso.BuildPath(here, "skin-host.pid")
busy = False
On Error Resume Next
If fso.FileExists(pidPath) Then
  Set probe = fso.OpenTextFile(pidPath, 8, True)
  If Err.Number = 0 Then
    probe.Close
  ElseIf Err.Number = 70 Or Err.Number = 75 Then
    busy = True
  End If
  Err.Clear
End If
On Error GoTo 0
If busy Then WScript.Quit 0

psExe = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & hostScript & """ -Watch"
' 0 = hidden window, False = do not wait
shell.Run command, 0, False
