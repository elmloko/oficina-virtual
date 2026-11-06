import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, splitRow, inlineTokens } from './markdown.js';

const types = (blocks) => blocks.map((b) => b.type);
const textOf = (item) => item.blocks.map((b) => b.text ?? `[${b.type}]`).join(' / ');

test('tablas: cabecera, alineación y filas, separadas del texto que las rodea', () => {
  const md = 'Resumen:\n\n| Causa | Impacto |\n|---|:---:|\n| **Gráfica** | 🔴 Alto |\n| Pantalla | 🟠 Medio |\n\nFin.';
  const parts = parseBlocks(md);
  assert.deepEqual(types(parts), ['text', 'table', 'text']);
  assert.equal(parts[0].text, 'Resumen:');
  assert.deepEqual(parts[1].header, ['Causa', 'Impacto']);
  assert.deepEqual(parts[1].align, [null, 'center']);
  assert.deepEqual(parts[1].rows, [['**Gráfica**', '🔴 Alto'], ['Pantalla', '🟠 Medio']]);
  assert.equal(parts[2].text, 'Fin.');
});

test('tablas: sin barras en los bordes, filas cortas se rellenan y las largas se recortan', () => {
  const [t] = parseBlocks('a | b | c\n--- | --- | ---:\n1 | 2\n1 | 2 | 3 | 4');
  assert.deepEqual(t.header, ['a', 'b', 'c']);
  assert.deepEqual(t.align, [null, null, 'right']);
  assert.deepEqual(t.rows, [['1', '2', ''], ['1', '2', '3']]);
});

test('texto con barras sin separador no es tabla; lo de dentro de ``` queda como código', () => {
  assert.deepEqual(parseBlocks('ruta a|b y c|d'), [{ type: 'text', text: 'ruta a|b y c|d' }]);
  assert.deepEqual(parseBlocks('```sql\n| a | b |\n|---|---|\n# no es título\n- ni lista\n```'),
    [{ type: 'code', lang: 'sql', text: '| a | b |\n|---|---|\n# no es título\n- ni lista' }]);
  assert.deepEqual(parseBlocks('```\nsin cerrar'), [{ type: 'code', lang: '', text: 'sin cerrar' }]);
  assert.deepEqual(parseBlocks(''), []);
  assert.deepEqual(parseBlocks(null), []);
});

test('títulos: niveles 1 a 6; «#9» o «#hashtag» sin espacio no son títulos', () => {
  assert.deepEqual(parseBlocks('# Uno\n## 2) Diagnóstico ##\n###### Seis'), [
    { type: 'heading', level: 1, text: 'Uno' }, { type: 'heading', level: 2, text: '2) Diagnóstico' }, { type: 'heading', level: 6, text: 'Seis' },
  ]);
  assert.deepEqual(types(parseBlocks('#9 terminó\n#hashtag')), ['text']);
});

test('listas: numerada con su inicio, viñetas anidadas y líneas de continuación (caso real)', () => {
  const md = [
    '## 2) Plan',
    '',
    '1. **Saber el desgaste.** Este comando genera un informe:',
    '   `powercfg /batteryreport`',
    '   El informe muestra la capacidad.',
    '2. **Apagar la NVIDIA:**',
    '   - En OMEN, modo **Híbrido**.',
    '   - En Configuración → Gráficos.',
    '3. **Quitar programas del inicio.**',
    '',
    'Texto final.',
  ].join('\n');
  const blocks = parseBlocks(md);
  assert.deepEqual(types(blocks), ['heading', 'list', 'text']);
  const list = blocks[1];
  assert.equal(list.ordered, true);
  assert.equal(list.start, 1);
  assert.equal(list.items.length, 3);
  assert.equal(textOf(list.items[0]), '**Saber el desgaste.** Este comando genera un informe:\n`powercfg /batteryreport`\nEl informe muestra la capacidad.');
  assert.deepEqual(types(list.items[1].blocks), ['text', 'list']);
  const sub = list.items[1].blocks[1];
  assert.equal(sub.ordered, false);
  assert.deepEqual(sub.items.map(textOf), ['En OMEN, modo **Híbrido**.', 'En Configuración → Gráficos.']);
  assert.equal(blocks[2].text, 'Texto final.');
});

test('listas: separadas por líneas en blanco siguen siendo una; cambiar de tipo empieza otra', () => {
  const loose = parseBlocks('- a\n\n- b\n\n- c');
  assert.equal(loose.length, 1);
  assert.equal(loose[0].items.length, 3);
  assert.deepEqual(types(parseBlocks('- a\n- b\n1. uno\n2. dos')), ['list', 'list']);
  assert.equal(parseBlocks('3. tres\n4. cuatro')[0].start, 3);
  assert.deepEqual(types(parseBlocks('* a\n\n---\n\n* b')), ['list', 'rule', 'list']);
});

test('celdas: respeta \\| y las barras dentro de `código`', () => {
  assert.deepEqual(splitRow('| a \\| b | `x | y` | c |'), ['a | b', '`x | y`', 'c']);
});

test('formato en línea: negrita, cursiva y código (anidados); lo que no cierra queda como texto', () => {
  assert.deepEqual(inlineTokens('**Docker** usa `wsl` y 2*3'), [
    { t: 'b', kids: [{ t: 'text', v: 'Docker' }] }, { t: 'text', v: ' usa ' }, { t: 'code', v: 'wsl' }, { t: 'text', v: ' y 2*3' },
  ]);
  assert.deepEqual(inlineTokens('**usa `npm`**'), [{ t: 'b', kids: [{ t: 'text', v: 'usa ' }, { t: 'code', v: 'npm' }] }]);
  assert.deepEqual(inlineTokens('*ojo* y _nota_'), [{ t: 'i', kids: [{ t: 'text', v: 'ojo' }] }, { t: 'text', v: ' y ' }, { t: 'i', kids: [{ t: 'text', v: 'nota' }] }]);
  assert.deepEqual(inlineTokens('mi_variable_larga y a * b * c'), [{ t: 'text', v: 'mi_variable_larga y a * b * c' }]);
  assert.deepEqual(inlineTokens('**sin cerrar'), [{ t: 'text', v: '**sin cerrar' }]);
  assert.deepEqual(inlineTokens('<b>no es html</b>'), [{ t: 'text', v: '<b>no es html</b>' }]);
});
