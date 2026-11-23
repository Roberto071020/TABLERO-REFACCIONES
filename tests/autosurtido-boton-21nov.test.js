// 21-nov-2026 (Orlando: "no me deja avanzar de este menú, donde pongo la pieza que se necesita del carro para Daniela"):
// el botón "Guardar y mandar a Daniela" tenía split('\n') dentro de una plantilla; el salto de línea real
// rompía el onclick y el botón no hacía nada. Esta prueba arma el botón igual que la pantalla y verifica que
// el código del onclick compila y separa las piezas por renglón.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('el botón de autosurtido de Orlando compila y separa piezas por renglón', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const linea = src.split('\n').find(l => l.includes('Guardar y mandar a Daniela'));
  assert.ok(linea, 'no se encontró el botón');
  const plantilla = linea.trim().replace(/<\/div>`\);$/, '');
  const id = 381, terminar = true;
  const html = eval('`' + plantilla + '`');
  const codigo = html.match(/onclick="([^"]*)"/)[1];
  let recibido;
  const fn = new Function('orlGuardarTipo', 'document', codigo);
  fn((a, b, c, piezas) => { recibido = piezas; }, { getElementById: () => ({ value: 'Calavera derecha\r\nFaro izquierdo' }) });
  assert.deepStrictEqual(recibido, ['Calavera derecha', 'Faro izquierdo']);
});
