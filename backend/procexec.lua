-- Hidden process launcher.
--
-- Millennium's utils.exec is `_popen` on Windows. `_popen` always starts
-- `cmd.exe /c ...`, a console process, so every call can flash a window and
-- steal focus from a fullscreen game. PowerShell -WindowStyle Hidden does
-- not fix that: the cmd wrapper appears first.
--
-- This module starts *one* wscript.exe supervisor (Windows subsystem, no
-- console) through that unavoidable _popen hop at Steam/plugin load. Every
-- later launch is a job file the supervisor picks up and runs with
-- WScript.Shell.Run(..., 0), which never allocates a console.

local fs = require("fs")
local utils = require("utils")

local procexec = {}

local jobSeq = 0
local supervisorStarted = false

local function pause_ms(ms)
	if pcall(utils.sleep, ms) then
		return
	end
	local untilClock = os.clock() + (ms / 1000)
	while os.clock() < untilClock do
	end
end

local function win_root()
	return os.getenv("SystemRoot") or os.getenv("WINDIR") or "C:\\Windows"
end

local function resolve_exe(name)
	local n = string.lower(tostring(name or ""))
	local win = win_root()
	if n == "powershell" or n == "powershell.exe" then
		return win .. "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
	end
	if n == "pwsh" or n == "pwsh.exe" then
		return win .. "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
	end
	if n == "wscript" or n == "wscript.exe" then
		return win .. "\\System32\\wscript.exe"
	end
	if n == "cmd" or n == "cmd.exe" then
		return nil
	end
	return tostring(name)
end

local function jobs_dir(tempDir)
	return fs.join(tempDir, "proc_jobs")
end

local function alive_path(tempDir)
	return fs.join(jobs_dir(tempDir), "_supervisor_alive")
end

local function stop_path(tempDir)
	return fs.join(jobs_dir(tempDir), "_supervisor_stop.flag")
end

local function supervisor_script_path(tempDir)
	return fs.join(jobs_dir(tempDir), "_supervisor.vbs")
end

local function launcher_script_path(tempDir)
	return fs.join(tempDir, "_hidden_run.vbs")
end

local function write_launcher(tempDir)
	pcall(fs.create_directories, tempDir)
	local script = table.concat({
		"Dim args, shellObj, i, cmd",
		"Set args = WScript.Arguments",
		"cmd = \"\"",
		"For i = 0 To args.Count - 1",
		"  If i > 0 Then cmd = cmd & \" \"",
		"  cmd = cmd & Chr(34) & args(i) & Chr(34)",
		"Next",
		"Set shellObj = CreateObject(\"WScript.Shell\")",
		"shellObj.Run cmd, 0, False",
		"",
	}, "\r\n")
	utils.write_file(launcher_script_path(tempDir), script)
	return launcher_script_path(tempDir)
end

local function write_supervisor(tempDir)
	local dir = jobs_dir(tempDir)
	pcall(fs.create_directories, dir)
	local script = table.concat({
		"Option Explicit",
		"Dim fso, sh, watch, stopFlag, alive, beat, folder, f, ts",
		"Set fso = CreateObject(\"Scripting.FileSystemObject\")",
		"Set sh = CreateObject(\"WScript.Shell\")",
		"watch = WScript.Arguments(0)",
		"stopFlag = watch & \"\\_supervisor_stop.flag\"",
		"alive = watch & \"\\_supervisor_alive\"",
		"beat = 0",
		"",
		"Function ReadUtf8(path)",
		"  On Error Resume Next",
		"  Dim stm",
		"  Set stm = CreateObject(\"ADODB.Stream\")",
		"  stm.Type = 2",
		"  stm.Charset = \"utf-8\"",
		"  stm.Open",
		"  stm.LoadFromFile path",
		"  ReadUtf8 = stm.ReadText",
		"  stm.Close",
		"End Function",
		"",
		"Function Quote(s)",
		"  Quote = Chr(34) & s & Chr(34)",
		"End Function",
		"",
		"Sub TickAlive()",
		"  On Error Resume Next",
		"  beat = beat + 1",
		"  Set ts = fso.CreateTextFile(alive, True)",
		"  ts.Write CStr(beat)",
		"  ts.Close",
		"End Sub",
		"",
		"Sub WriteUtf8(path, text)",
		"  On Error Resume Next",
		"  Dim stm",
		"  Set stm = CreateObject(\"ADODB.Stream\")",
		"  stm.Type = 2",
		"  stm.Charset = \"utf-8\"",
		"  stm.Open",
		"  stm.WriteText text",
		"  stm.SaveToFile path, 2",
		"  stm.Close",
		"End Sub",
		"",
		"Sub RunJob(path)",
		"  On Error Resume Next",
		"  Dim raw, parts, waitIt, cmd, i, wrap, donePath, cmdFile",
		"  raw = ReadUtf8(path)",
		"  If raw = \"\" Then",
		"    fso.DeleteFile path, True",
		"    Exit Sub",
		"  End If",
		"  parts = Split(Replace(raw, vbCrLf, vbLf), vbLf)",
		"  If UBound(parts) < 1 Then",
		"    fso.DeleteFile path, True",
		"    Exit Sub",
		"  End If",
		"  waitIt = (parts(0) = \"1\")",
		"  cmd = \"\"",
		"  For i = 1 To UBound(parts)",
		"    If parts(i) <> \"\" Then",
		"      If cmd <> \"\" Then cmd = cmd & \" \"",
		"      cmd = cmd & Quote(parts(i))",
		"    End If",
		"  Next",
		"  donePath = path & \".done\"",
		"  If waitIt Then",
		"    cmdFile = path & \".cmdline\"",
		"    wrap = path & \".wrap.vbs\"",
		"    WriteUtf8 cmdFile, cmd",
		"    Set ts = fso.CreateTextFile(wrap, True)",
		"    ts.WriteLine \"Set sh = CreateObject(\"\"WScript.Shell\"\")\"",
		"    ts.WriteLine \"Set stm = CreateObject(\"\"ADODB.Stream\"\")\"",
		"    ts.WriteLine \"stm.Type = 2\"",
		"    ts.WriteLine \"stm.Charset = \"\"utf-8\"\"\"",
		"    ts.WriteLine \"stm.Open\"",
		"    ts.WriteLine \"stm.LoadFromFile \" & Quote(cmdFile)",
		"    ts.WriteLine \"cmd = stm.ReadText\"",
		"    ts.WriteLine \"stm.Close\"",
		"    ts.WriteLine \"sh.Run cmd, 0, True\"",
		"    ts.WriteLine \"Set fso = CreateObject(\"\"Scripting.FileSystemObject\"\")\"",
		"    ts.WriteLine \"Set out = fso.CreateTextFile(\" & Quote(donePath) & \", True)\"",
		"    ts.WriteLine \"out.Write \"\"1\"\"\"",
		"    ts.WriteLine \"out.Close\"",
		"    ts.Close",
		"    sh.Run Quote(WScript.FullName) & \" //B //Nologo \" & Quote(wrap), 0, False",
		"  Else",
		"    sh.Run cmd, 0, False",
		"  End If",
		"  fso.DeleteFile path, True",
		"End Sub",
		"",
		"Do While Not fso.FileExists(stopFlag)",
		"  TickAlive",
		"  If fso.FolderExists(watch) Then",
		"    Set folder = fso.GetFolder(watch)",
		"    For Each f In folder.Files",
		"      If LCase(Right(f.Name, 4)) = \".run\" Then",
		"        RunJob f.Path",
		"      End If",
		"    Next",
		"  End If",
		"  WScript.Sleep 120",
		"Loop",
		"",
	}, "\r\n")
	utils.write_file(supervisor_script_path(tempDir), script)
	return supervisor_script_path(tempDir)
end

local function heartbeat_advances(tempDir)
	local path = alive_path(tempDir)
	if not fs.exists(path) then
		return false
	end
	local ok1, first = pcall(utils.read_file, path)
	if not ok1 or not first or first == "" then
		return false
	end
	pause_ms(400)
	local ok2, second = pcall(utils.read_file, path)
	return ok2 and second and second ~= "" and second ~= first
end

local function bootstrap_supervisor(tempDir)
	pcall(fs.remove, stop_path(tempDir))
	local jobsDir = jobs_dir(tempDir)
	pcall(fs.create_directories, jobsDir)
	local supervisor = write_supervisor(tempDir)
	local launcher = write_launcher(tempDir)
	local wscript = resolve_exe("wscript.exe")
	-- Single _popen/cmd hop for the whole Steam session. The launcher VBS
	-- is Windows-subsystem and returns immediately after starting the
	-- supervisor with SW_HIDE.
	local cmd = string.format(
		'"%s" //B //Nologo "%s" "%s" "//B" "//Nologo" "%s" "%s"',
		wscript,
		launcher,
		wscript,
		supervisor,
		jobsDir
	)
	return pcall(utils.exec, cmd)
end

function procexec.purge_queued_jobs(tempDir)
	local dir = jobs_dir(tempDir)
	local ok, entries = pcall(fs.list, dir)
	if not ok or type(entries) ~= "table" then
		return
	end
	for _, entry in ipairs(entries) do
		local name = tostring(entry)
		if name:match("%.run$") or name:match("%.run%.done$") or name:match("%.wrap%.vbs$") then
			procexec.delete_file(fs.join(dir, name))
		end
	end
end

function procexec.ensure_supervisor(tempDir, force)
	if not tempDir or tempDir == "" then
		return false
	end
	write_supervisor(tempDir)
	if supervisorStarted and not force then
		return true
	end
	if heartbeat_advances(tempDir) then
		supervisorStarted = true
		return true
	end
	supervisorStarted = false
	local ok = bootstrap_supervisor(tempDir)
	if not ok then
		return false
	end
	if heartbeat_advances(tempDir) then
		supervisorStarted = true
		return true
	end
	supervisorStarted = false
	return false
end

function procexec.job_exists(path)
	return type(path) == "string" and path ~= "" and fs.exists(path)
end

function procexec.launch_hidden_argv(argv, tempDir)
	if type(argv) ~= "table" or not argv[1] then
		return false
	end
	write_launcher(tempDir)
	local wscript = resolve_exe("wscript.exe")
	local launcher = launcher_script_path(tempDir)
	if not wscript or not launcher then
		return false
	end
	local first = resolve_exe(argv[1])
	if not first then
		return false
	end
	local parts = {
		string.format('"%s"', wscript),
		"//B",
		"//Nologo",
		string.format('"%s"', launcher),
		string.format('"%s"', first),
	}
	for i = 2, #argv do
		parts[#parts + 1] = string.format('"%s"', tostring(argv[i]))
	end
	return pcall(utils.exec, table.concat(parts, " "))
end

local function write_job(argv, tempDir, wait)
	if not procexec.ensure_supervisor(tempDir) then
		return nil
	end
	local resolved = {}
	local first = resolve_exe(argv[1])
	if not first then
		return nil
	end
	resolved[1] = first
	for i = 2, #argv do
		resolved[i] = tostring(argv[i])
	end
	jobSeq = jobSeq + 1
	local path = fs.join(jobs_dir(tempDir), string.format("_job_%d.run", jobSeq))
	local lines = { wait and "1" or "0" }
	for i = 1, #resolved do
		lines[#lines + 1] = resolved[i]
	end
	pcall(utils.write_file, path, table.concat(lines, "\n") .. "\n")
	return path
end

function procexec.run_hidden(argv, tempDir)
	return write_job(argv, tempDir, false)
end

function procexec.run_hidden_wait(argv, tempDir)
	local path = write_job(argv, tempDir, true)
	if not path then
		return false
	end
	local donePath = path .. ".done"
	local tries = 0
	while tries < 36000 do
		if fs.exists(donePath) then
			pcall(fs.remove, donePath)
			pcall(fs.remove, path .. ".wrap.vbs")
			return true
		end
		pause_ms(50)
		tries = tries + 1
	end
	return false
end

function procexec.child_path(dir, entry)
	local s = tostring(entry or "")
	if s == "" or s == "." or s == ".." then
		return nil
	end
	if s:match("^%a:[/\\]") or s:sub(1, 1) == "/" or s:sub(1, 2) == "\\\\" then
		return s
	end
	if s:find("[/\\]") then
		return s
	end
	return fs.join(dir, s)
end

function procexec.delete_file(path)
	if not path or path == "" then
		return true
	end
	pcall(os.remove, path)
	pcall(fs.remove, path)
	return not fs.exists(path)
end

function procexec.wipe_dir(path)
	if not path or path == "" or not fs.exists(path) then
		return
	end
	local ok, entries = pcall(fs.list, path)
	if ok and type(entries) == "table" then
		for _, entry in ipairs(entries) do
			local child = procexec.child_path(path, entry)
			if child then
				local dirOk, isDir = pcall(fs.is_directory, child)
				if dirOk and isDir then
					procexec.wipe_dir(child)
				else
					procexec.delete_file(child)
				end
			end
		end
	end
	pcall(os.remove, path)
	pcall(fs.remove, path)
end

return procexec
