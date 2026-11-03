@echo off
setlocal
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  where py >nul 2>nul
  if errorlevel 1 (python -m venv .venv) else (py -3 -m venv .venv)
  if errorlevel 1 goto :failed
)
.venv\Scripts\python.exe -c "import parquet_lens, fastapi, uvicorn, duckdb, pyarrow" >nul 2>nul
if errorlevel 1 (
  .venv\Scripts\python.exe -m ensurepip --upgrade
  .venv\Scripts\python.exe -m pip install .
  if errorlevel 1 goto :failed
)
.venv\Scripts\python.exe -m parquet_lens %*
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo Unable to start. Install Python 3.10+ and check the message above.
pause
exit /b 1
