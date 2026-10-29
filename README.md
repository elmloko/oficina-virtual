# Oficina virtual · Base Rebelde

Oficina 2D pixel-art (tema Star Wars, arte original) para asignar tareas a los agentes de `~/.claude/agents`.

    npm install
    npm start        # http://127.0.0.1:4000
    npm test         # server + public

- **Oficina**: cada agente en su sala; trabajando / en cola / por revisar / falló. Clic = ver misión o asignarle una.
- **Tablero**: kanban global (arrastra entre Hangar / Por revisar / Completadas).
- **Objetivos**: el coordinador (Claude) divide un objetivo en pasos con dependencias; revisas el plan y lo lanzas.
- **Rutinas**: plantillas programadas (siempre solo lectura), incluido el informe operativo sobre los Excel de `@Descargas`. Solo corren con el servidor encendido.
- **Carpetas extra** (`EXTRA_ROOTS`): fuera de htdocs, siempre solo lectura, visibles como `@Nombre`.
- **Costos**: presupuesto diario, tope por tarea, timeout, auditoría.

Motor híbrido: Claude (`claude -p`, usa tu suscripción) y Ollama local (tareas ligeras).
Seguridad: solo 127.0.0.1; proyectos solo dentro de `HTDOCS_ROOT`; editar archivos exige confirmación;
agentes de infraestructura (devops, iac, cloud…) fuerzan solo lectura. Variables en `.env.example`.
