@echo off
rem Detiene la oficina virtual que corre en segundo plano (el proceso que escucha en el puerto 4000).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:4000 .*LISTENING"') do (
  taskkill /pid %%p /f >nul && echo Oficina detenida ^(PID %%p^).
)
pause
