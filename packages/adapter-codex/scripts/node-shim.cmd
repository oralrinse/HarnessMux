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
rem an absolute node path instead works only until that node disappears - and the
rem obvious candidate, Codex's own runtime, lives in a *versioned* directory
rem (`runtimes\cua_node\<hash>\bin\node.exe`) that is replaced whenever Codex
rem updates. That is not hypothetical: it broke this plugin once already, taking
rem the MCP server and the lifecycle hooks down together.
rem
rem So node is resolved here, at spawn time, every time. `cmd.exe` is the one
rem executable that is both findable by name and permanent, which makes it the
rem stable anchor those entries point at.
rem
rem Resolution order:
rem   1. HARNESSMUX_NODE          explicit override
rem   2. node.exe beside this file (a portable install)
rem   3. node on PATH             nvm / fnm / volta / system install
rem   4. every Codex runtime, newest first   the host's own node
rem
rem Step 4 reads the *current* hash rather than a remembered one, which is what
rem makes a Codex update survivable.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
set "HERE=%~dp0"

if "%~1"=="" (
	>&2 echo harnessmux: node-shim.cmd needs a script name, e.g. launch-mcp.mjs
	exit /b 2
)
set "TARGET=%HERE%%~1"
shift
if not exist "%TARGET%" (
	>&2 echo harnessmux: %TARGET% does not exist
	exit /b 2
)

set "NODE="
if defined HARNESSMUX_NODE if exist "%HARNESSMUX_NODE%" set "NODE=%HARNESSMUX_NODE%"
if not defined NODE if exist "%HERE%node.exe" set "NODE=%HERE%node.exe"

if not defined NODE (
	for /f "delims=" %%I in ('where node.exe 2^>nul') do (
		if not defined NODE if exist "%%I" set "NODE=%%I"
	)
)

if not defined NODE (
	for /f "delims=" %%D in ('dir /b /ad /o-d "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node" 2^>nul') do (
		if not defined NODE if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\%%D\bin\node.exe" set "NODE=%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\%%D\bin\node.exe"
	)
)

if not defined NODE (
	>&2 echo harnessmux: no node found. Set HARNESSMUX_NODE to an absolute node path.
	exit /b 127
)

"%NODE%" "%TARGET%" %*
exit /b %ERRORLEVEL%
