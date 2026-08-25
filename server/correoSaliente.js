const nodemailer = require('nodemailer');

// Preparación de la integración con Gmail (investigación del 25-ago-2026, Camino B: cuenta
// dedicada + contraseña de aplicación, confirmado por Roberto porque serviciocristian.mx es
// Gmail normal, sin Google Workspace). Este módulo queda inerte mientras Roberto no configure
// las variables de entorno GMAIL_USER y GMAIL_APP_PASSWORD en Render — no se usa ninguna
// credencial real aquí, y nada de lo demás en el sistema cambia de comportamiento mientras
// falten. SEG-001: nunca se guarda la contraseña en el código ni en la base de datos, solo como
// variable de entorno.

function configurado(){
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let transportador = null;
function obtenerTransportador(){
  if(!configurado()) return null;
  if(!transportador){
    transportador = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
  }
  return transportador;
}

// Envía un correo real. Lanza un error con mensaje claro si no está configurado o si Gmail
// rechaza el envío (auth inválida, límite de envíos, destinatario rechazado, etc.) — quien llama
// decide qué hacer (en la ruta de comunicaciones, se deja el correo en estado 'aprobado' para
// que Daniela lo pueda seguir enviando a mano, como hoy).
async function enviarCorreo({ to, cc, subject, text }){
  const t = obtenerTransportador();
  if(!t){
    const err = new Error('El envío automático por Gmail no está configurado (faltan GMAIL_USER / GMAIL_APP_PASSWORD).');
    err.code = 'GMAIL_NO_CONFIGURADO';
    throw err;
  }
  return t.sendMail({ from: process.env.GMAIL_USER, to, cc: cc || undefined, subject, text });
}

module.exports = { configurado, enviarCorreo };
