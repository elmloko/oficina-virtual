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
- **Costos**: costo por agente y por día, auditoría.
- **Sistema**: salud (servidor, Claude CLI, Ollama, carpetas), cola en vivo con pausa y cancelación total, actividad del día, fallos, próximas rutinas, registro en vivo, ajustes (presupuesto, timeout, concurrencia por motor) y administración de claves de proveedores (se guardan en `.env`, nunca se muestran).

Motores: Claude (`claude -p`, usa tu suscripción, con acceso a archivos), Ollama local y **modelos en internet**
(Anthropic API, OpenAI, Gemini, OpenRouter, Groq, DeepSeek o cualquier API compatible con OpenAI vía `CUSTOM_LLM`).
Los de internet son solo chat: no ven ni editan archivos; reciben únicamente el texto de la misión. Claves solo en `.env`.
Seguridad: solo 127.0.0.1; proyectos solo dentro de `HTDOCS_ROOT`; editar archivos exige confirmación;
agentes de infraestructura (devops, iac, cloud…) fuerzan solo lectura. Variables en `.env.example`.

## Skins

El botón flotante **Skin** (abajo a la izquierda) cambia el tema de toda la app sin recargar: paleta de la interfaz, decorado de las salas, escena animada del ventanal, emblema, nombres de departamentos y atuendo de cada personaje.

Clásico · Imperio (Estrella de la Muerte) · Rebelión (Yavin 4) · Tatooine · Templo Jedi · Hoth · Mandaloriano · Lado Oscuro (Mustafar) · Rogue One (Scarif) · **Auto** (Tatooine de día, Imperio de noche).

La elección se guarda en el navegador de cada equipo; `?skin=sith` fuerza uno por URL. Para crear otro skin, añade una entrada en `public/skins.js` (las pruebas validan contraste, escena, emblema y atuendos).

## Responder a un agente

Al tocar un avatar se abre su panel: misión actual con registro en vivo, **última respuesta** y historial. Bajo la última respuesta (y dentro de cada misión terminada del historial) hay un campo para contestarle (Ctrl+Enter envía): la misma misión se vuelve a ejecutar y el agente continúa con la conversación como contexto (`POST /api/tasks/:id/reply`).

- Cada ejecución es independiente (`--no-session-persistence`): la conversación viaja en el prompt (respuesta anterior del agente + mensaje del usuario, últimos 12 mensajes), por eso funciona igual con Claude, Ollama y proveedores en internet. No hay sesión viva a la que inyectar texto: mientras una misión corre, la respuesta se habilita cuando termina.
- Si la misión edita archivos, pide la misma confirmación que al ejecutarla. Respetan los mismos topes de presupuesto, cola y modo de solo lectura de infraestructura.
- No aplica a objetivos (planes); sí a los pasos.
