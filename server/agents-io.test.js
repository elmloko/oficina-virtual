// Importar / exportar agentes sin repetir: mismo contenido = ya lo tienes; mismo nombre distinto = no se pisa.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'oficina-agio-'));
const agentsDir = join(tmp, 'agents');
mkdirSync(agentsDir);
const md = (name, desc, body = 'Eres un agente de prueba.') => `---\nname: ${name}\ndescription: "${desc}"\ntools: Read, Grep\n---\n${body}\n`;
writeFileSync(join(agentsDir, 'revisor.md'), md('revisor', 'Revisa código'));
writeFileSync(join(agentsDir, 'tester.md'), md('tester', 'Escribe tests'));
// Otras carpetas del equipo: un plugin (copiado en dos sitios, como hace Claude Code) y un proyecto.
const plugins = join(tmp, 'plugins');
for (const where of ['marketplaces', 'cache']) {
  mkdirSync(join(plugins, where, 'plugins', 'feature-dev', 'agents'), { recursive: true });
  writeFileSync(join(plugins, where, 'plugins', 'feature-dev', 'agents', 'code-architect.md'), md('code-architect', 'Diseña arquitecturas'));
}
mkdirSync(join(plugins, 'marketplaces', 'plugins', 'otro', 'agents'), { recursive: true });
writeFileSync(join(plugins, 'marketplaces', 'plugins', 'otro', 'agents', 'revisor.md'), md('revisor', 'Otro revisor distinto', 'Otro cuerpo.'));
writeFileSync(join(plugins, 'marketplaces', 'plugins', 'otro', 'agents', 'notas.md'), 'sin frontmatter: no es un agente');
const projects = join(tmp, 'htdocs');
mkdirSync(join(projects, 'tienda', '.claude', 'agents'), { recursive: true });
writeFileSync(join(projects, 'tienda', '.claude', 'agents', 'copia-tester.md'), md('tester', 'Escribe tests').replace(/\n/g, '\r\n')); // mismo agente con CRLF
const sources = [{ label: 'Plugins', path: plugins }, { label: 'Proyectos', path: projects }];
process.env.AGENTS_DIR = agentsDir;

const { parseAgent, planImport, applyImport, exportBundle, scanSources, normalize } = await import('./agents-io.js');
const { openDb } = await import('./db.js');
const { createApp } = await import('./index.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

test('parseAgent: nombre del frontmatter (o del archivo), exige descripción y nombres seguros', () => {
  const a = parseAgent(md('Laravel', 'Backend Laravel'), 'x.md');
  assert.deepEqual([a.name, a.description, a.tools], ['laravel', 'Backend Laravel', 'Read, Grep']);
  assert.equal(parseAgent('---\ndescription: d\n---\nhola', 'C:/x/mi-agente.md').name, 'mi-agente');
  assert.equal(parseAgent('---\nname: creador\ndescription: |\n  Crea agentes.\n  En dos líneas.\nmodel: sonnet\n---\nx').description, 'Crea agentes. En dos líneas.');
  assert.match(parseAgent('sin encabezado').error, /falta el encabezado/);
  assert.match(parseAgent('---\nname: x1\n---\nhola').error, /descripción/);
  assert.match(parseAgent(md('../fuera', 'malo')).error, /inválido/);
  assert.match(parseAgent(md('a'.repeat(5), 'd', 'x'.repeat(70 * 1024))).error, /grande/);
  assert.equal(normalize('\uFEFFa \r\nb\r\n\r\n'), 'a\nb\n', 'BOM, CRLF y espacios finales no cuentan');
});

test('planImport: nuevo, igual (aunque cambie el nombre o los saltos de línea), conflicto, repetido e inválido', () => {
  const plan = planImport([
    { content: md('nuevo-uno', 'Algo nuevo') },
    { content: md('revisor', 'Revisa código').replace(/\n/g, '\r\n') },
    { content: md('tester', 'Escribe tests').replace('name: tester', 'name: probador') },
    { content: md('revisor', 'Otro revisor', 'distinto') },
    { content: md('nuevo-uno', 'Algo nuevo') },
    { content: md('nuevo-uno', 'Mismo nombre, otro contenido', 'z') },
    { content: 'basura', filename: 'basura.md' },
  ], agentsDir);
  assert.deepEqual(plan.map((p) => p.status), ['nuevo', 'igual', 'igual', 'conflicto', 'repetido', 'repetido', 'invalido']);
  assert.match(plan[2].reason, /como «tester»/);
});

test('applyImport: guarda solo los nuevos y nunca pisa un agente tuyo', async () => {
  const antes = readFileSync(join(agentsDir, 'revisor.md'), 'utf8');
  const r = await applyImport([{ content: md('importado-a', 'Importado A') }, { content: md('revisor', 'Pisarlo', 'no') }], agentsDir);
  assert.deepEqual(r.map((x) => [x.name, x.status]), [['importado-a', 'importado'], ['revisor', 'conflicto']]);
  assert.equal(readFileSync(join(agentsDir, 'revisor.md'), 'utf8'), antes);
  assert.ok(!('content' in r[0]), 'la respuesta no repite el contenido');
  const again = await applyImport([{ content: md('importado-a', 'Importado A') }], agentsDir);
  assert.equal(again[0].status, 'igual', 'importar dos veces no duplica');
  rmSync(join(agentsDir, 'importado-a.md'));
});

test('applyImport: si la carpeta de agentes no existe (PC nueva), la crea y sigue', async () => {
  const nueva = join(tmp, 'pc-nueva', '.claude', 'agents');
  const r = await applyImport([{ content: md('primero', 'Primer agente') }], nueva);
  assert.equal(r[0].status, 'importado');
  assert.deepEqual(readdirSync(nueva), ['primero.md']);
});

test('exportar y volver a importar el paquete no repite nada', async () => {
  const b = exportBundle(agentsDir);
  assert.equal(b.format, 'oficina-agentes');
  assert.deepEqual(b.agents.map((a) => a.name), ['revisor', 'tester']);
  assert.deepEqual(exportBundle(agentsDir, ['tester']).agents.map((a) => a.name), ['tester']);
  const r = await applyImport(b.agents.map((a) => ({ content: a.content })), agentsDir);
  assert.deepEqual(r.map((x) => x.status), ['igual', 'igual']);
});

test('scanSources: encuentra agentes de plugins y proyectos, quita copias y marca lo que ya tienes', () => {
  const found = scanSources(sources, agentsDir);
  const by = Object.fromEntries(found.map((f) => [`${f.name}@${f.source}`, f.status]));
  assert.deepEqual(by, {
    'code-architect@Plugins · feature-dev': 'nuevo', // estaba en dos carpetas: aparece una vez
    'revisor@Plugins · otro': 'conflicto',
    'tester@Proyectos · tienda': 'igual',
  });
  assert.ok(found.every((f) => /^[0-9a-f]{64}$/.test(f.id) && !('content' in f)));
});

test('API: exportar, previsualizar, importar archivos y desde el escaneo (solo ids conocidos)', async () => {
  const app = createApp({ db: openDb(':memory:'), attachmentsDir: join(tmp, 'att'), agentSources: sources });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (body) => { const r = await fetch(`${base}/api/agents/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const ex = await fetch(`${base}/api/agents/export`);
    assert.match(ex.headers.get('content-disposition'), /attachment; filename="agentes-\d{4}-\d{2}-\d{2}\.json"/);
    assert.equal((await ex.json()).agents.length, 2);

    const files = { agents: [{ filename: 'diseno.md', content: md('diseno', 'Diseño UI') }, { filename: 'tester.md', content: md('tester', 'Escribe tests') }] };
    const dry = await post({ ...files, dry: true });
    assert.deepEqual(dry.body.results.map((r) => r.status), ['nuevo', 'igual']);
    assert.ok(!readdirSync(agentsDir).includes('diseno.md'), 'la vista previa no escribe nada');
    const real = await post(files);
    assert.deepEqual(real.body.results.map((r) => r.status), ['importado', 'igual']);
    assert.ok(app.db.auditLog(10).some((x) => x.action === 'agent.import'));

    const scan = await (await fetch(`${base}/api/agents/scan`)).json();
    const arch = scan.agents.find((a) => a.name === 'code-architect');
    const imp = await post({ ids: [arch.id, 'f'.repeat(64)] }); // un id inventado se ignora
    assert.deepEqual(imp.body.results.map((r) => [r.name, r.status]), [['code-architect', 'importado']]);
    assert.equal((await post({ ids: ['../../etc'] })).status, 400);
    assert.equal((await post({ agents: [] })).status, 400);
    assert.equal((await post({ agents: Array(201).fill({ content: 'x' }) })).status, 400);
  } finally { app.server.close(); app.server.closeAllConnections?.(); }
});
