@echo off
rem Inicia la oficina virtual en Windows (usa el Claude Code, Codex y Ollama de esta PC).
rem Para cerrarla: cierra esta ventana o pulsa Ctrl+C.
cd /d "%~dp0"
title Oficina virtual - http://localhost:4000
where claude >nul 2>nul || echo AVISO: no encuentro "claude" en el PATH; las misiones iran a Ollama.
node server\index.js
pause