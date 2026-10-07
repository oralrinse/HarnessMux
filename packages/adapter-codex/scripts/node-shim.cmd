@echo off
rem ---------------------------------------------------------------------------
rem HarnessMux node shim for Windows hosts.
rem
rem Usage:  node-shim.cmd <script-under-this-directory> [args...]
rem   e.g.  node-shim.cmd launch-mcp.mjs
rem         node-shim.cmd pending.mjs --actor codex
rem
rem Why this file exists: the Codex desktop app does not put node on the PATH of
rem the processes it spawns, so an MCP entry that says "node" cannot start. Writing
rem an absolute node path instead works only until that node disappears, and the
rem obvious candidate - Codex's own runtime - lives in a *versioned* directory
rem (`runtimes\cua_node\<hash>\bin\node.exe`) that is replaced whenever Codex
rem updates. That has now happened twice.
rem
rem So node is resolved here, at spawn time, every time. `cmd.exe` is the one
rem executable that is both findable by name and permanent, which makes it the
rem stable anchor those entries point at.
rem
rem Resolution order:
rem   1. HARNESSMUX_NODE              explicit override
rem   2. node.exe beside this file    a portable install
rem   3. node on PATH                 nvm / fnm / volta / system install
rem   4. LocalAppData - environment or registry - then the Codex runtimes under it
rem   5. nvm's own version directories, newest first
rem   6. a node bundled with an editor
rem
rem Step 4 exists because a host may hand its children a *rewritten* PATH: when
rem `where node.exe` misses, LocalAppData is the next thing to trust, and it can be
rem recovered from the registry even when the variable itself never arrived. Steps
rem 5-6 are the honest acknowledgement that this machine has no system-wide node and
rem that the runtimes which do exist can be replaced under us.
rem
rem Keep this file pure ASCII: cmd.exe reads a .cmd in the console's OEM code page,
rem so a non-ASCII byte splits into several characters and each is run as a command.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
set "HERE=%~dp0"

if "%~1"=="" (
	>&2 echo harnessmux: node-shim.cmd needs a script name, e.g. launch-mcp.mjs
	exit /b 2
)
set "TARGET=%HERE%%~1"
if not exist "%TARGET%" (
	>&2 echo harnessmux: %TARGET% does not exist
	exit /b 2
)

set "NODE="

rem 1. explicit override
if defined HARNESSMUX_NODE if exist "%HARNESSMUX_NODE%" set "NODE=%HARNESSMUX_NODE%"

rem 2. beside the shim
if not defined NODE if exist "%HERE%node.exe" set "NODE=%HERE%node.exe"

rem 3. PATH
if not defined NODE (
	for /f "delims=" %%I in ('where node.exe 2^>nul') do (
		if not defined NODE if exist "%%I" set "NODE=%%I"
	)
)

rem 4a. LocalAppData, derived if the variable was not passed
set "LAD=%LOCALAPPDATA%"
if not defined LAD if defined USERPROFILE set "LAD=%USERPROFILE%\AppData\Local"
if not defined LAD (
	for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" /v "Local AppData" 2^>nul ^| findstr /i "Local"') do (
		if not defined LAD set "LAD=%%B"
	)
)

rem 4b. the Codex runtimes under LocalAppData, newest directory first
if not defined NODE if defined LAD (
	for /f "delims=" %%D in ('dir /b /ad /o-d "%LAD%\OpenAI\Codex\runtimes\cua_node" 2^>nul') do (
		if not defined NODE if exist "%LAD%\OpenAI\Codex\runtimes\cua_node\%%D\bin\node.exe" set "NODE=%LAD%\OpenAI\Codex\runtimes\cua_node\%%D\bin\node.exe"
	)
)

rem 5. nvm's version directories, newest first
if not defined NODE (
	for /f "delims=" %%D in ('dir /b /ad /o-d "%APPDATA%\nvm" 2^>nul') do (
		if not defined NODE if exist "%APPDATA%\nvm\%%D\node.exe" set "NODE=%APPDATA%\nvm\%%D\node.exe"
	)
)

rem 6. a node bundled with an editor
if not defined NODE if defined LAD (
	for %%P in (
		"%LAD%\Programs\nodejs\node.exe"
		"%LAD%\Programs\Microsoft VS Code\node.exe"
		"%LAD%\Programs\cursor\resources\app\resources\helpers\node.exe"
	) do (
		if not defined NODE if exist %%P set "NODE=%%~P"
	)
)
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"

if not defined NODE (
	>&2 echo harnessmux: no node found. Set HARNESSMUX_NODE to an absolute node path.
	>&2 echo   searched: this directory, PATH, LocalAppData, Codex runtimes, nvm, editor bundles.
	exit /b 127
)

"%NODE%" "%TARGET%" %*
exit /b %ERRORLEVEL%
