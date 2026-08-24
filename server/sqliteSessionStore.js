// Almacén de sesiones para express-session respaldado en la misma base SQLite del proyecto
// (sin agregar dependencias nuevas: usa el mismo db.js / node:sqlite que ya usa todo lo demás).
// Corrige el reporte de Daniela: con el MemoryStore por default, cada reinicio del proceso
// (cada despliegue) borraba todas las sesiones activas y el login parecía fallar con "Sesión expirada".
const { Store } = require('express-session');

class SqliteSessionStore extends Store {
  constructor(db){
    super();
    this.db = db;
    this._stmtGet = db.prepare('SELECT datos, expira_en FROM sesiones WHERE sid = ?');
    this._stmtSet = db.prepare('INSERT INTO sesiones (sid, datos, expira_en) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET datos=excluded.datos, expira_en=excluded.expira_en');
    this._stmtDestroy = db.prepare('DELETE FROM sesiones WHERE sid = ?');
    this._stmtTouch = db.prepare('UPDATE sesiones SET expira_en = ? WHERE sid = ?');
    this._stmtPurge = db.prepare('DELETE FROM sesiones WHERE expira_en < ?');
    // Limpieza periódica de sesiones vencidas (cada hora), para no acumular filas indefinidamente.
    this._interval = setInterval(()=>{ try{ this._stmtPurge.run(Date.now()); }catch(e){} }, 60*60*1000);
    if(this._interval.unref) this._interval.unref();
  }

  _expiraEn(session){
    const maxAge = (session.cookie && session.cookie.maxAge) ? session.cookie.maxAge : (1000*60*60*12);
    return Date.now() + maxAge;
  }

  get(sid, cb){
    try{
      const row = this._stmtGet.get(sid);
      if(!row) return cb(null, null);
      if(row.expira_en < Date.now()){ this._stmtDestroy.run(sid); return cb(null, null); }
      cb(null, JSON.parse(row.datos));
    }catch(e){ cb(e); }
  }
  set(sid, session, cb){
    try{
      this._stmtSet.run(sid, JSON.stringify(session), this._expiraEn(session));
      cb && cb();
    }catch(e){ cb && cb(e); }
  }
  destroy(sid, cb){
    try{ this._stmtDestroy.run(sid); cb && cb(); }
    catch(e){ cb && cb(e); }
  }
  touch(sid, session, cb){
    try{ this._stmtTouch.run(this._expiraEn(session), sid); cb && cb(); }
    catch(e){ cb && cb(e); }
  }
}

module.exports = SqliteSessionStore;
