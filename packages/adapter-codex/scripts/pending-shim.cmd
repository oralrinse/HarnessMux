@echo off
rem ---------------------------------------------------------------------------
rem HarnessMux lifecycle-hook shim for Windows hosts.
rem
rem Sibling of `node-shim.cmd`, and deliberately just as dumb: it resolves node and
rem runs `pending.mjs` with whatever arguments Codex passed.
rem
rem Why a shim at all: hook commands must be absolute, and Codex resolves them
rem against the directory holding hooks.json rather than the plugin, so a relative
rem `node ./scripts/pending.mjs` fails with `Cannot find module`. Naming node by an
rem absolute path fails later instead of sooner - Codex's runtime lives in a
rem *versioned* directory that an update replaces, which is how the MCP server and
rem the hooks broke together.
rem
rem Resolution order matches node-shim.cmd exactly; see that file for the detail.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
set "HERE=%~dp0"
set "TARGET=%HERE%pending.mjs"

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
