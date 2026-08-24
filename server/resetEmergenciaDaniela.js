// Reset de emergencia, una sola vez: Daniela quedó bloqueada fuera del tablero (ver correo del
// 2026-08-22) y no se pudo confirmar si el motivo era una contraseña olvidada u otra cosa. Como medida
// inmediata (además de la corrección del bug de mensaje de error), se le fija una contraseña conocida
// para que pueda volver a entrar de inmediato. Idempotente: solo corre una vez (verifica un marcador
// en auditoría) para no resetear su contraseña en cada arranque del servidor.
const bcrypt = require('bcryptjs');
const db = require('./db');
const { registrarAuditoria } = require('./utils');

const MARCADOR = 'reset_emergencia_daniela_2026-08-24';
const NUEVA_PASSWORD = 'ServicioCristian2026-Reset!';

function resetEmergenciaDaniela(){
  const yaCorrio = db.prepare("SELECT id FROM auditoria WHERE accion = ?").get(MARCADOR);
  if(yaCorrio) return;

  const u = db.prepare("SELECT * FROM usuarios WHERE email = 'daniela@serviciocristian.mx'").get();
  if(!u) return;

  const hash = bcrypt.hashSync(NUEVA_PASSWORD, 10);
  db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hash, u.id);
  registrarAuditoria(db, { entidad_tipo:'usuario', entidad_id:u.id, accion: MARCADOR, usuario:null,
    valor_nuevo: 'Contraseña reseteada de emergencia por bloqueo de acceso reportado' });
  console.log('Reset de emergencia aplicado a la cuenta de Daniela.');
}

module.exports = { resetEmergenciaDaniela };
