// Modos de una misión: qué puede hacer el agente y qué te entrega.
// «level» es el permiso real: read (no cambia nada), edit (archivos del proyecto), infra (servidor), full (este equipo). Todos valen con cualquier motor.
// «prompt» se añade a las instrucciones de la misión, sea cual sea el motor.
export const MODE_INFO = {
  read: {
    label: 'Analizar y proponer un plan', level: 'read',
    prompt: 'Modo análisis (no cambias nada). Entrega: 1) diagnóstico de la situación actual, con la evidencia que lo respalda; 2) un plan numerado con pasos concretos; 3) riesgos y cómo verificar cada paso; 4) tu recomendación final en una o dos frases.',
  },
  explain: {
    label: 'Investigar y explicar', level: 'read',
    prompt: 'Modo explicación (no cambias nada). Empieza por la respuesta corta en una o dos frases; después explica paso a paso, de forma clara y didáctica, con ejemplos concretos. Si hay código o archivos, cita archivo:línea. Distingue lo que comprobaste de lo que supones, y termina con qué mirar si quiere profundizar.',
  },
  review: {
    label: 'Revisar y dar feedback', level: 'read',
    prompt: 'Modo revisión (no cambias nada). Revisa con ojo crítico lo indicado (código, texto, plan o idea). Entrega los hallazgos ordenados por gravedad (🔴 grave, 🟠 importante, 🟡 menor), cada uno con dónde está, por qué es un problema y cómo arreglarlo; después, lo que está bien; cierra con un veredicto claro (listo / con cambios / rehacer).',
  },
  write: {
    label: 'Redactar un texto', level: 'read',
    prompt: 'Modo redacción. Escribe el texto pedido listo para usar (correo, informe, documento, mensaje, publicación…), con el tono y la extensión adecuados para quien lo va a leer. Entrega primero el texto final completo, fácil de copiar; después, solo si aporta, una variante breve o una nota. No expliques cómo lo escribiste.',
  },
  ideas: {
    label: 'Lluvia de ideas', level: 'read',
    prompt: 'Modo lluvia de ideas. Propón entre 5 y 10 opciones distintas y concretas (no variaciones de la misma). Para cada una: en qué consiste, ventajas, desventajas y esfuerzo (bajo / medio / alto). Cierra con tu recomendación y por qué.',
  },
  summary: {
    label: 'Resumir', level: 'read',
    prompt: 'Modo resumen. Resume el material (lo que dice la misión, los adjuntos o los archivos indicados): la idea principal en una o dos frases; los puntos clave en viñetas; datos, fechas y cifras importantes; y las acciones o pendientes que se desprenden. No añadas nada que no esté en el material.',
  },
  translate: {
    label: 'Traducir', level: 'read',
    prompt: 'Modo traducción. Traduce el texto al idioma indicado (si no se indica: al español si está en otro idioma, o al inglés si está en español), conservando formato, tono y términos técnicos. Entrega solo la traducción; al final, y solo si las hay, notas breves sobre términos dudosos.',
  },
  edit: {
    label: 'Editar archivos del proyecto', level: 'edit',
    prompt: 'Modo edición. Haz los cambios tú mismo en los archivos del proyecto: primero entiende el código y su estilo, luego cambios mínimos y coherentes con lo que ya existe (no añadas dependencias sin justificarlo). Después ejecuta las pruebas, el linter o el build que existan. Cierra con un resumen: qué cambiaste (archivo:línea), cómo lo verificaste con la salida real y qué quedó pendiente.',
  },
  infra: { label: 'Operar un servidor', level: 'infra', prompt: null }, // sus reglas viven en infraPrompt (runner.js)
  full: { label: 'Control total en este equipo', level: 'full', prompt: null }, // sus reglas viven en fullPrompt (runner.js)

  // ---------- Modos para el trabajo de cada día. Los que actúan («recetas») usan el permiso de su «level»
  // (se guardan como mode=level + recipe=clave) y añaden su forma de trabajar. «agent»: agente sugerido si existe.

  // No cambian nada
  debug_plan: {
    label: 'Diagnosticar un error (te digo qué hacer)', level: 'read', agent: 'depurador',
    prompt: 'Modo diagnóstico (no cambias nada). A partir del error, el síntoma o el log que te dan (HTTP 500, «no carga», pantalla en blanco, excepción…): 1) la causa más probable y otras posibles, de la más a la menos probable; 2) cómo confirmar cada una (comandos o pasos exactos, primero los de solo lectura); 3) el arreglo concreto para la causa confirmada; 4) cómo verificar que quedó resuelto. Si falta un dato clave, di exactamente qué salida o archivo necesitas.',
  },
  sql: {
    label: 'Base de datos y consultas SQL', level: 'read', agent: 'base-datos',
    prompt: 'Modo base de datos (no cambias nada). Entrega la consulta o el cambio de esquema listo para ejecutar (indica el motor: MySQL/MariaDB, PostgreSQL o SQLite), explicado línea a línea si no es trivial. Si modifica o borra datos, márcalo con ⚠, propón antes un SELECT para ver qué afectaría y el respaldo previo. Sugiere índices si la consulta lo necesita. En Laravel, ofrece también la versión con Eloquent o la migración.',
  },
  diplomado: {
    label: 'Ejercicio o clase de Python / IA', level: 'read', agent: 'datos-ia',
    prompt: 'Modo estudio (diplomado de IA). Explica de forma didáctica: 1) qué pide el ejercicio y los conceptos que usa (con una intuición sencilla antes de la fórmula); 2) la solución en Python completa y comentada, que se ejecute con `py archivo.py` (indica los paquetes con `py -m pip install …`); 3) qué salida esperar y cómo interpretarla; 4) errores típicos (intérprete equivocado en VS Code, paquete sin instalar, rutas) y cómo resolverlos. Si te pasan código que falla, primero explica por qué falla.',
  },
  excel_help: {
    label: 'Fórmulas, macros y tablas de Excel', level: 'read',
    prompt: 'Modo Excel (no cambias archivos). Entrega lo pedido listo para pegar: fórmulas (en la versión en español de Excel, con separador «;», y la equivalente en inglés), macros VBA completas y comentadas (dónde pegarlas: Alt+F11 → Insertar → Módulo, y cómo ejecutarlas), o los pasos exactos de tablas dinámicas (filas, columnas, valores y filtros). Advierte qué hacer antes si borra o sobrescribe datos (copia del archivo).',
  },
  compare: {
    label: 'Comparar opciones y recomendar', level: 'read',
    prompt: 'Modo comparación (no cambias nada). Compara las opciones (herramientas, modelos, librerías, servicios o enfoques) en una tabla con los criterios que importan para el caso (para software en este equipo: requisitos de RAM/CPU/GPU y disco, si funciona sin internet, costo, facilidad de uso, calidad). Después: la recomendación concreta para su situación, por qué, y los pasos para empezar. Distingue lo comprobado de lo que supones y avisa si algo puede estar desactualizado.',
  },
  docs: {
    label: 'Documentar (README, manual o guía)', level: 'read', agent: 'documentador',
    prompt: 'Modo documentación. Escribe en español la documentación pedida (README, manual de usuario, guía de instalación o despliegue, documentación de API…) en Markdown, lista para guardar: propósito, requisitos, instalación, configuración (variables de entorno sin valores secretos), uso con ejemplos, y solución de problemas frecuentes. Básate solo en lo que ves o te dan; marca con «(por confirmar)» lo que no puedas comprobar.',
  },

  // Editan el proyecto
  fix: {
    label: 'Arreglar un error en el proyecto', level: 'edit', agent: 'depurador',
    prompt: 'Modo arreglo. 1) Reproduce o localiza el error (logs, stack trace, prueba); 2) encuentra la causa raíz antes de tocar nada (no parches el síntoma); 3) corrige con el cambio mínimo, respetando el estilo del proyecto; 4) verifica: el error ya no ocurre y las pruebas pasan (en PHP, `php -l` en lo editado y `php artisan test` si existe; en Node, `npm test`). Cierra con: causa, qué cambiaste (archivo:línea), cómo lo verificaste con la salida real.',
  },
  laravel: {
    label: 'Nueva función Laravel / Livewire', level: 'edit', agent: 'laravel',
    prompt: 'Modo Laravel. Implementa la funcionalidad siguiendo las convenciones del proyecto y de Laravel: migración (nunca edites una ya ejecutada: crea una nueva), modelo Eloquent con relaciones y $fillable, validación (Form Request o reglas en Livewire), rutas con nombre, permisos o policies si el proyecto los usa, componente Livewire 3 con su vista Blade (búsqueda, paginación y modal si es un CRUD). Reutiliza componentes y estilos existentes. Verifica con `php -l` en cada archivo PHP editado, `php artisan route:list` y los tests. Al final, lista los comandos que el usuario debe ejecutar (migraciones, caché).',
  },
  ui: {
    label: 'Mejorar la interfaz (diseño y usabilidad)', level: 'edit', agent: 'frontend',
    prompt: 'Modo interfaz. Mejora lo indicado pensando en quien la usa: orden y agrupación clara, jerarquía visual, textos y etiquetas comprensibles, estados vacíos, de carga y de error, botones con acciones claras, accesibilidad (contraste, foco, etiquetas) y que se vea bien en móvil. Reutiliza los estilos, variables y componentes que ya existen; no añadas librerías sin justificarlo. Cierra con qué cambió y por qué, archivo:línea.',
  },
  tests: {
    label: 'Escribir y correr tests', level: 'edit', agent: 'tester',
    prompt: 'Modo pruebas. Usa el framework de tests que ya tiene el proyecto (PHPUnit/Pest, node:test/Jest/Vitest, pytest con `py -m pytest`). Cubre el camino feliz, los bordes y los errores de lo indicado, con nombres descriptivos. Ejecuta los tests y muestra la salida real. Si un test revela un bug, no cambies el test para que pase: repórtalo (y arréglalo solo si es claro y pequeño).',
  },

  // Operan un servidor (por la oficina: lo fuerte te lo pregunta)
  srv_status: {
    label: 'Servidor: contenedores, URLs y estado', level: 'infra', agent: 'devops',
    prompt: 'Modo inventario del servidor (solo lectura: no cambies nada). Averigua y entrega en una tabla: cada contenedor (nombre, imagen, estado, tiempo encendido), sus puertos publicados, la URL con la que se entra (IP:puerto y dominios de los server_name de nginx o de las variables APP_URL/WP_HOME), a qué base de datos apunta (host, puerto y nombre de la BD, de su .env o variables) y si responde (curl -sk -o /dev/null -w "%{http_code}"). Añade uso de disco y memoria, y avisa de lo raro (contenedores reiniciándose, certificados por vencer, disco casi lleno).',
  },
  srv_pull: {
    label: 'Servidor: traer cambios de git y redesplegar', level: 'infra', agent: 'devops',
    prompt: 'Modo actualizar desde git. 1) Localiza el código de la app (docker inspect: montajes o directorio de compose) y el repositorio; 2) `git status` y `git log -1`: si hay cambios locales sin commit, NO los pierdas (muéstralos y haz `git stash` o copia antes); 3) `git fetch` y muestra qué commits llegan; 4) `git pull`; 5) si cambiaron dependencias o migraciones, ejecuta lo necesario (composer install --no-dev, npm ci && npm run build, php artisan migrate --force, php artisan optimize:clear) dentro del contenedor correcto; 6) reinicia o reconstruye SOLO ese contenedor; 7) verifica: logs sin errores y la URL responde. Resume commits traídos y cómo volver atrás (git reset al commit anterior).',
  },
  srv_web: {
    label: 'Servidor: dominios, puertos, HTTPS y certificados', level: 'infra', agent: 'devops',
    prompt: 'Modo web del servidor (nginx, puertos, HTTPS). Antes de cambiar: mira la configuración actual (docker ps con puertos, archivos de nginx, docker-compose.yml) y haz copia de cada archivo que edites. Para certificados: comprueba la fecha de vencimiento (openssl x509 -enddate) y de dónde se cargan. Para redirecciones a otro puerto o dominio: revisa la URL base de la app (APP_URL/ASSET_URL en Laravel; siteurl/home en WordPress) y las cabeceras del proxy (X-Forwarded-Proto/Host). Si las imágenes o iconos no cargan: busca contenido mixto (http dentro de https), URLs base o CORS. Valida con `nginx -t` antes de recargar y verifica cada URL con curl -skI al terminar.',
  },
  srv_fix: {
    label: 'Servidor: app caída, error 500 o que no conecta', level: 'infra', agent: 'devops',
    prompt: 'Modo emergencia en el servidor. Primero solo lectura: estado del contenedor (docker ps -a), sus últimos logs (docker logs --tail 200) y los de la app (storage/logs en Laravel, error.log de nginx/PHP). Comprueba la configuración que suele fallar: variables de entorno (host y credenciales de BD, URL del backend que usa el frontend), red entre contenedores (mismo network, nombre del servicio), permisos de storage/ y bootstrap/cache, espacio en disco. Explica la causa encontrada antes de cambiar; después aplica el arreglo mínimo, reinicia solo lo necesario y verifica con curl y los logs. Resume causa, arreglo y cómo deshacerlo.',
  },

  // Este equipo (control total)
  pc_setup: {
    label: 'Mi PC: instalar y configurar programas', level: 'full',
    prompt: 'Modo instalación en este equipo (Windows 11). Comprueba antes si ya está instalado y qué versión (winget list, --version). Instala preferentemente con winget (o npm/py -m pip/el instalador oficial), nunca desde webs de terceros. Configura lo pedido (variables de entorno, PATH, archivos de configuración con copia previa) y verifica que funciona ejecutándolo. Al final: qué instalaste (versión), dónde quedó la configuración y cómo desinstalarlo.',
  },
  local_ai: {
    label: 'Mi PC: modelos de IA locales (Ollama / LM Studio)', level: 'full', agent: 'datos-ia',
    prompt: 'Modo IA local. Trabajas con los modelos de este equipo: Ollama (`ollama list`, `ollama pull`, `ollama rm`, API en http://localhost:11434) y LM Studio (`lms ls`, `lms get`, carpeta de modelos configurable). Antes de descargar, revisa RAM, VRAM y espacio libre en disco y elige el tamaño y la cuantización que caben (di cuánto ocupará). Para probar o comparar, haz la misma pregunta corta a cada modelo y mide tiempo y calidad. Antes de borrar modelos, lista lo que se liberará. Resume qué quedó instalado, dónde, y cuál recomiendas para qué.',
  },
  excel_files: {
    label: 'Mi PC: procesar archivos de Excel', level: 'full',
    prompt: 'Modo archivos de Excel. Nunca modifiques el original: trabaja sobre una copia (nombre_procesado.xlsx) en la misma carpeta. Usa Python (`py`, con openpyxl o pandas: instálalos con `py -m pip install` si faltan) para leer, consolidar, limpiar o generar tablas resumen; si piden macros, entrega además el código VBA y dónde pegarlo. Si el archivo está abierto en Excel y da error de acceso, pide que lo cierren. Verifica el resultado leyéndolo de nuevo (filas, totales) y resume qué hiciste y dónde quedó.',
  },
};

export const MODES = new Set(Object.keys(MODE_INFO));
/** Permiso real de un modo: los modos base son su propio nivel; las recetas usan el de su «level». */
export const levelOf = (mode) => MODE_INFO[mode]?.level ?? 'read';
/** Traduce lo que elige el usuario a lo que se guarda: una receta que actúa → { mode: su nivel, recipe: la clave }. */
export function splitMode(mode) {
  const level = levelOf(mode);
  return level !== 'read' && level !== mode ? { mode: level, recipe: mode } : { mode, recipe: null };
}
/** Agente sugerido por el modo (si existe entre los agentes instalados). */
export const modeAgent = (mode, agents) => { const a = MODE_INFO[mode]?.agent; return a && agents.some((x) => x.name === a) ? a : null; };
/** Modos que no cambian nada: valen con cualquier motor (también los de solo chat). */
export const READ_MODES = new Set(Object.entries(MODE_INFO).filter(([, m]) => m.level === 'read').map(([k]) => k));
export const modeLabel = (mode) => MODE_INFO[mode]?.label ?? mode;
export const modePrompt = (mode) => (MODE_INFO[mode]?.prompt ? `--- ${MODE_INFO[mode].label} ---\n${MODE_INFO[mode].prompt}` : null);
