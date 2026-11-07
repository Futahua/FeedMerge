' Runs the hourly FeedMerge backup without showing a window.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node --no-warnings """ & dir & "\backup.mjs""", 0, True
