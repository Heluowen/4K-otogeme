@echo off
rem ===========================================================================
rem  rhythm-4k C backend —— Windows 一键构建
rem
rem  等价于 Makefile 的 all 目标，但不需要安装 make。
rem  用法：双击本文件，或在 cmd 里运行 build.bat
rem ===========================================================================
setlocal
cd /d "%~dp0"

where gcc >nul 2>nul
if errorlevel 1 (
  echo.
  echo   gcc not found.
  echo.
  echo   Install MinGW-w64 or MSYS2, then make sure gcc is on PATH.
  echo   After installing, run build.bat again.
  echo.
  pause
  exit /b 1
)

if not exist build mkdir build

set CFLAGS=-std=c11 -Wall -Wextra -Wpedantic -O2 -Iinclude
set SRC=src\common.c src\buf.c src\str.c src\json.c src\osu_parser.c src\osu_json.c src\http.c src\static.c src\server.c src\main.c

echo.
echo   Building rhythm4k-server.exe ...
echo.
gcc %CFLAGS% %SRC% -o build\rhythm4k-server.exe -lws2_32
if errorlevel 1 (
  echo.
  echo   Build failed.
  echo.
  pause
  exit /b 1
)

echo   OK: build\rhythm4k-server.exe
echo.
echo   Run it with:
echo     build\rhythm4k-server.exe --root ..\dist
echo.
exit /b 0
