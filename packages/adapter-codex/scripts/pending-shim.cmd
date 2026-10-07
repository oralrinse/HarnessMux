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
rem The important part is step 4: a host may hand its children a rewritten PATH, so
rem LocalAppData is derived from USERPROFILE or the registry rather than trusted.
rem
rem Keep this file pure ASCII: cmd.exe reads a .cmd in the console's OEM code page,
rem so a non-ASCII byte splits into several characters and each one is run as a
rem command.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
set "HERE=%~dp0"
set "TARGET=%HERE%pending.mjs"
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
