// Inicio de Alejandra (5-nov-2026) -- ver server/inicioAlejandra.js para el proceso y las reglas.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { verificarReingreso90Porciento } = require('../utils');
const inicio = require('../inicioAlejandra');
const router = express.Router();

const ROLES = ['atencion_cliente', 'admin', 'jefe'];

function responderError(res, e){
  res.status(e.status || 500).json({ error: e.message, codigo: e.codigo, fotos: e.fotos });
}

router.get('/', requireAuth, requireRole(...ROLES), (req, res)=>{
  try{ verificarReingreso90Porciento(db); }catch(e){ /* respaldo: no debe impedir ver la pantalla */ }
  res.json(inicio.calcularInicioAlejandra(db));
});

// Confirma que se le avisó al cliente (WhatsApp enviado o "ya se le había avisado").
router.post('/:id/aviso', requireAuth, requireRole(...ROLES), (req, res)=>{
  try{
    const { codigo, tipo, modo } = req.body || {};
    if(!codigo) return res.status(400).json({ error:'Falta indicar qué aviso se envió.' });
    res.status(201).json(inicio.registrarAviso(db, { siniestroId: Number(req.params.id), codigo: String(codigo), tipo, modo, usuario: req.session.user }));
  }catch(e){ responderError(res, e); }
});

router.get('/:id/fotos-recepcion', requireAuth, requireRole(...ROLES), (req, res)=>{
  res.json({ fotos: inicio.fotosRecepcionHoy(db, Number(req.params.id)), minimo: inicio.FOTOS_MINIMAS_RECEPCION });
});

router.post('/:id/llego', requireAuth, requireRole(...ROLES), (req, res)=>{
  try{ res.json(inicio.registrarLlegada(db, { siniestroId: Number(req.params.id), usuario: req.session.user })); }
  catch(e){ responderError(res, e); }
});

module.exports = router;
