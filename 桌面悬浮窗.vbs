Option Explicit

Dim shell, fso, projectDir, electronPath, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronPath = projectDir & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electronPath) Then
    MsgBox "Desktop component is not installed. Run npm install first.", 48, "Personal Dashboard"
    WScript.Quit 1
End If

command = """" & electronPath & """ """ & projectDir & "\desktop-panel"""
shell.Run command, 0, False
