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
- **Detener y editar:** mientras el agente trabaja en una respuesta, la ✕ de «Ahora» la detiene y la **deshace**: la misión vuelve a su estado anterior (con su resultado previo) y tu mensaje reaparece en el campo para corregirlo y reenviarlo; el mensaje equivocado nunca llega al agente. Cancelar una ejecución normal (no una respuesta) la devuelve al Hangar como antes. Lo que ya gastó la ejecución cancelada no se suma (no hay costo parcial); al completar una respuesta, su costo se suma al de la misión.

## Avisos y bandeja de atención

- **Campana «Avisos»** (cabecera): sonido (con timbre propio por skin) y notificación del navegador cuando una misión termina, falla, te hace una pregunta o un plan queda listo. La notificación de escritorio solo sale con la pestaña oculta y hay que dejar la pestaña abierta; el permiso se pide al activar la campana.
- El título de la pestaña muestra `(n)` con lo que espera tu atención.
- **Pestaña «Atención»**: preguntas del agente (heurística: la respuesta termina en pregunta), fallidas, planes por lanzar y resultados por revisar, con responder, aprobar, reintentar, «Al Hangar» y acciones en lote.

## Cambios aislados en una rama git (misiones que editan)

Cuando una misión en modo edición corre en un proyecto git con commits, **no toca el proyecto**: trabaja en una copia aislada (`git worktree` en `data/worktrees/<id>`, rama `oficina/m<id>`; configurable con `WORKTREES_DIR`). Al terminar, sus cambios quedan en un commit de esa rama y el panel muestra «Cambios en archivos» con el diff.

- **Aplicar a mi proyecto**: hace `git merge --no-ff` de la rama en la rama actual del proyecto. Pide confirmación (`confirm:true` en la API); se rechaza si el proyecto tiene cambios sin guardar o está en HEAD desacoplado, y ante un conflicto se aborta el merge sin dejar nada a medias.
- **Descartar**: borra la rama y la copia; el proyecto no se toca. También ocurre al borrar la misión.
- Responder al agente (o reintentar) continúa en la misma rama. Cancelar una ejecución a medias devuelve la copia a su último commit. Si la misión no modificó archivos no queda rama.
- La copia solo trae lo versionado: no incluye `vendor/`, `node_modules/` ni `.env` (lo ignorado por git). Proyectos sin git (o sin commits) se editan en su sitio, y la misión lo avisa porque no se podrá revertir.
- API: `GET /api/tasks/:id/changes`, `POST /api/tasks/:id/apply`, `POST /api/tasks/:id/discard`.

## Revisión cruzada automática

Al crear una misión puedes marcar **revisores** (`reviewer`, `security`, `tester`). Cuando la misión termina bien, se crean y lanzan solas una misión de solo lectura por revisor (`review_of`, dependen de la original):

- Reciben el resultado de la misión original y, si editó archivos en una rama, el **diff** (hasta 20 KB) y leen el código en esa copia aislada.
- Su veredicto llega a la bandeja de atención y se enlaza desde el panel de la misión original («Revisiones automáticas»).
- Se lanzan **una sola vez** (responder o reintentar después no las repite) y solo si la misión original terminó bien. Un revisor que no pueda lanzarse (p. ej. presupuesto diario agotado) deja un aviso en el registro pero nunca marca fallida a la misión original.
- Máximo 4 revisores, sin repetir y sin el propio autor. Cada revisión cuenta para el presupuesto diario.

## Buscar, exportar y métricas

- **Tablero**: barra de búsqueda (título, descripción, resultado, error, agente, proyecto; sin distinguir acentos; `#12` busca por número) y filtros por agente, proyecto y estado. Muestra «N de M». «⭳ Exportar .md» descarga las misiones filtradas en un solo documento.
- **Una misión**: en su panel, «⭳ .md» (Markdown con metadatos, conversación y resultado) y «⭳ PDF» (abre una versión imprimible; elige «Guardar como PDF»). El contenido se escapa: nunca se interpreta como HTML.
- **Métricas por agente**: pestaña Costos (misiones, tasa de éxito, fallidas, aprobadas, tiempo medio, costo total y por misión) y una línea resumen en el panel de cada agente. Se calculan con las misiones que siguen en el tablero; las eliminadas dejan de contar.

## Adjuntos

- En «Nueva misión» y en el campo de respuesta al agente: botón «📎 Adjuntar» o pega una captura con Ctrl+V. En el panel de una misión se listan (con miniatura si es imagen), se pueden quitar o añadir más.
- Permitidos: imágenes (png, jpg, gif, webp), PDF y texto/código (txt, md, csv, json, log, xml, yml, sql, php, js, ts, css, html). Se comprueba que el contenido coincida con la extensión; SVG y ejecutables se rechazan. Máx. 8 MB por archivo, 10 por misión y 25 MB en total.
- **Claude** recibe la ruta de cada archivo (y `--add-dir` de su carpeta) y los lee con sus herramientas, imágenes y PDF incluidos. **Ollama y proveedores** solo reciben el texto de los archivos de texto (recortado); imágenes y PDF se avisan como no legibles.
- Se guardan en `data/attachments/<misión>/` (`ATTACHMENTS_DIR` para cambiarlo) con nombre generado por el servidor; al eliminar la misión se borran. Se descargan con `nosniff` y CSP `sandbox`, y solo las imágenes se muestran en línea.

## Mandar misiones desde el celular (Telegram)

Un bot de Telegram que hace *long polling*: el PC solo abre conexiones de salida, **no se expone la oficina a internet** (no hay puertos abiertos, túnel ni login que mantener).

1. Crea el bot con @BotFather y pon `TELEGRAM_BOT_TOKEN` en `.env`.
2. Arranca el servidor y escríbele al bot. Te ignorará, pero el log del servidor mostrará tu id de chat; ponlo en `TELEGRAM_ALLOWED_CHATS` (varios, separados por coma) y reinicia. **Sin esa lista el bot queda apagado.**
3. Comandos: `/estado`, `/pendientes`, `/nueva agente [@proyecto]: título`, `/ver 12`, `/responder 12 texto`, `/aprobar 12`, `/cancelar 12`.

Seguridad: solo responde a chats privados de la lista (los demás se ignoran sin contestar); desde Telegram solo se crean misiones de **solo lectura** (máx. 5 cada 10 min), no se pueden editar archivos, aplicar/descartar cambios ni borrar, y responder a una misión que edita exige hacerlo en la oficina. Los mensajes que escribiste con el PC apagado se descartan al arrancar. Los avisos (terminó, falló, te pregunta) solo llevan el título; el resultado sale de tu PC únicamente cuando lo pides con `/ver` (o la pregunta del agente, para poder contestarla). Todo viaja por los servidores de Telegram, así que no lo uses con misiones cuyo contenido sea confidencial.

No implementado a propósito: abrir la propia oficina desde fuera de casa. Exigiría login, HTTPS y un túnel (Cloudflare Tunnel/Tailscale), y hoy la oficina confía en que solo se accede desde `localhost`. Si lo necesitas, lo recomendable es Tailscale (acceso privado entre tus dispositivos) más un login.
