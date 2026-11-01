// Agentes de prueba en una carpeta temporal: los tests no dependen de los que haya en ~/.claude/agents.
// Debe importarse ANTES que config.js (primer import del test) para que AGENTS_DIR ya esté definido.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(mkdtempSync(join(tmpdir(), 'oficina-agents-')), 'agents');
mkdirSync(dir);
for (const name of ['backend', 'devops', 'docs', 'summarizer']) writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: "${name} de prueba"\n---\ncuerpo\n`);
process.env.AGENTS_DIR = dir;
