// ===================== Mi pantalla: tema y tamaño de letra por persona (27-nov-2026) =====================
// Roberto: "¿Podríamos agregar algunos fondos o temas?" (para el personal de oficina, no el de patio). Acordado:
//   - 6 temas ya armados (solo cambian fondo, encabezados y botones; el rojo/ámbar/verde de los avisos no cambia).
//   - Tamaño de letra: normal, grande, muy grande.
//   - Se guarda por persona en el servidor, así lo ve igual en su celular y en la computadora.
// Roberto: "no van a identificar que desde ahí pueden personalizar su pantalla" (un engrane) -> botón con texto
// "🎨 Mi pantalla" en el encabezado y una tarjeta en su inicio hasta que elijan o digan "Ahora no".
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const router = express.Router();

const TEMAS = ['claro', 'oscuro', 'cristian', 'mar', 'bosque', 'lavanda'];
const LETRAS = ['normal', 'grande', 'muy_grande'];

function asegurarColumnas(){
  for(const [col, tipo] of [['tema','TEXT'], ['letra','TEXT'], ['pantalla_elegida','INTEGER NOT NULL DEFAULT 0']]){
    if(!db.prepare(`SELECT 1 FROM pragma_table_info('usuarios') WHERE name=?`).get(col)) db.exec(`ALTER TABLE usuarios ADD COLUMN ${col} ${tipo}`);
  }
}
asegurarColumnas();

function leer(id){
  const u = db.prepare('SELECT tema, letra, pantalla_elegida FROM usuarios WHERE id = ?').get(id) || {};
  return { tema: TEMAS.includes(u.tema) ? u.tema : 'claro', letra: LETRAS.includes(u.letra) ? u.letra : 'normal', elegida: !!u.pantalla_elegida };
}

router.get('/', requireAuth, (req, res) => res.json(leer(req.session.user.id)));

// Guarda tema/letra; también sirve para "Ahora no" (solo marca que ya se le ofreció).
router.patch('/', requireAuth, (req, res) => {
  if(req.session.user.rol === 'tecnico') return res.status(403).json({ error:'No disponible para tu usuario.' });
  const b = req.body || {};
  const actual = leer(req.session.user.id);
  const tema = b.tema === undefined ? actual.tema : b.tema;
  const letra = b.letra === undefined ? actual.letra : b.letra;
  if(!TEMAS.includes(tema)) return res.status(400).json({ error:'Tema no válido.' });
  if(!LETRAS.includes(letra)) return res.status(400).json({ error:'Tamaño de letra no válido.' });
  db.prepare('UPDATE usuarios SET tema = ?, letra = ?, pantalla_elegida = 1 WHERE id = ?').run(tema, letra, req.session.user.id);
  res.json(leer(req.session.user.id));
});

module.exports = router;
module.exports.TEMAS = TEMAS;
