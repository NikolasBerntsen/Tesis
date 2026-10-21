@echo off
REM Atajo de siempre: hoy todo lo hace iniciar.bat (busca o crea el entorno de
REM Python, consigue el modelo, revisa el firewall y arranca el servidor).
REM Los argumentos se pasan tal cual: "correr.bat --modelo yolo11m-mix --imgsz 1536".

call "%~dp0iniciar.bat" %*
exit /b %ERRORLEVEL%
