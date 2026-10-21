@echo off
REM Doble clic: prepara y arranca el software de deteccion (ver README.md).
REM
REM Toda la logica esta en iniciar.ps1. Este archivo existe porque un .ps1 no se
REM abre con doble clic y la politica de ejecucion de Windows lo bloquea por
REM defecto: -ExecutionPolicy Bypass vale solo para esta ejecucion y no cambia
REM ninguna configuracion del sistema.
REM
REM   iniciar.bat                        prepara lo que falte y arranca
REM   iniciar.bat -SoloVerificar         todo menos arrancar (y sin pedir permisos)
REM   iniciar.bat --modelo yolo11m-mix   lo demas va tal cual a servidor.py

setlocal
set "AQUI=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%AQUI%iniciar.ps1" %*
set "CODIGO=%ERRORLEVEL%"
if "%CODIGO%"=="0" goto :fin

REM Abierto con doble clic (cmd /c ...), la ventana se cerraria con el error
REM sin dejarlo leer: se espera una tecla. Desde una consola abierta, no.
echo %CMDCMDLINE% | findstr /i /c:" /c " >nul
if not errorlevel 1 pause

:fin
exit /b %CODIGO%
