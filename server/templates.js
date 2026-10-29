// Plantillas de rutinas listas para usar. Siempre solo lectura.
export const TEMPLATES = [
  {
    id: 'informe-operativo', name: 'Informe operativo diario (Excel de Descargas)', agent: 'analyst', needsProject: true, defaultProject: '@Descargas',
    spec: { type: 'daily', time: '17:30', days: [1, 2, 3, 4, 5] },
    title: 'Informe operativo diario',
    description: 'En esta carpeta busca el archivo más reciente cuyo nombre empiece con "ASIGNACION DE OPERACIONES" (.xlsm/.xlsx). Léelo SOLO en modo lectura, sin modificarlo ni abrirlo con macros. Resume: operaciones asignadas, distribución por responsable o zona, pendientes, anomalías (celdas vacías, duplicados, valores atípicos) y cambios respecto a la versión anterior si existe. Entrega un informe ejecutivo breve con tablas y recomendaciones.',
  },
  {
    id: 'vigilancia-proyecto', name: 'Vigilancia diaria de proyecto', agent: 'reviewer', needsProject: true,
    spec: { type: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] },
    title: 'Vigilancia diaria: cambios recientes',
    description: 'Revisa con git los cambios de las últimas 24 horas (git log y git diff). Reporta bugs probables, regresiones, riesgos de aislamiento por tenant y archivos sensibles tocados. Termina con una lista priorizada.',
  },
  {
    id: 'auditoria-seguridad', name: 'Auditoría semanal de seguridad', agent: 'security', needsProject: true,
    spec: { type: 'daily', time: '07:00', days: [1] },
    title: 'Auditoría semanal de seguridad',
    description: 'Audita el proyecto: autenticación, autorización, inyecciones, secretos en el código, validación de entrada y aislamiento multi-tenant. Reporta hallazgos con severidad y archivo:línea.',
  },
  {
    id: 'auditoria-dependencias', name: 'Auditoría semanal de dependencias', agent: 'deps-auditor', needsProject: true,
    spec: { type: 'daily', time: '07:30', days: [1] },
    title: 'Auditoría semanal de dependencias',
    description: 'Revisa composer.json/composer.lock y package.json: paquetes obsoletos, vulnerabilidades conocidas y licencias. Propón actualizaciones ordenadas por riesgo.',
  },
  {
    id: 'informe-estado', name: 'Informe de estado del proyecto', agent: 'reporter', needsProject: true,
    spec: { type: 'daily', time: '18:00', days: [1, 2, 3, 4, 5] },
    title: 'Informe de estado diario',
    description: 'Genera un informe ejecutivo breve: avances recientes (git log), trabajo pendiente (TODO/FIXME, PLAN.md si existe), riesgos y próximos pasos.',
  },
  {
    id: 'investigacion-couriers', name: 'Investigación semanal de couriers', agent: 'researcher', needsProject: false,
    spec: { type: 'daily', time: '09:00', days: [1] },
    title: 'Investigación semanal: APIs y tarifas de couriers',
    description: 'Investiga en la web novedades de APIs de paqueterías relevantes para Bolivia y la región (cotización, guías, tracking, webhooks) y cambios de tarifas. Resume con fuentes y qué implicaría para el SaaS.',
  },
];
