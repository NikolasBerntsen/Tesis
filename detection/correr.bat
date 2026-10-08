@echo off
REM Lanza el servidor de deteccion con el Python correcto. Escribir "python" a
REM secas usa el del sistema, que no tiene torch ni ultralytics instalados.
REM Los argumentos se pasan tal cual: "correr.bat --modelo yolo11m-mix --imgsz 1536".

setlocal
set "AQUI=%~dp0"

REM 1) Un entorno propio en esta carpeta.
set "PY=%AQUI%.venv\Scripts\python.exe"
if exist "%PY%" goto :correr

REM 2) El entorno del proyecto de entrenamiento (la carpeta "tests ia tesis" del Escritorio).
set "PY=%USERPROFILE%\Desktop\tests ia tesis\.venv\Scripts\python.exe"
if exist "%PY%" goto :correr

REM 3) El entorno de ml/ en este mismo repo.
set "PY=%AQUI%..\ml\.venv\Scripts\python.exe"
if exist "%PY%" goto :correr

echo.
echo No encontre ningun entorno de Python con las dependencias.
echo.
echo Para crear uno en esta carpeta:
echo     python -m venv .venv
echo     .venv\Scripts\pip install -r requirements.txt
echo.
exit /b 1

:correr
echo Usando: %PY%
echo.
"%PY%" "%AQUI%servidor.py" %*
