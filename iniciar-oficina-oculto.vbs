' Arranca la oficina virtual en segundo plano (sin ventana). Se usa desde la carpeta Inicio de Windows.
' Registro: data\oficina.log. Para detenerla: Administrador de tareas > node.exe, o detener-oficina.cmd.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists("data") Then fso.CreateFolder("data")
sh.Run "cmd /c node server\index.js >> data\oficina.log 2>&1", 0, False
