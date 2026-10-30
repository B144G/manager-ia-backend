'use strict';
// Faux services pour les tests de la vague 3 : serveur SMTP (garde les messages reçus) et faux serveur IA (garde les consignes et données reçues).
const http = require('http');
const net = require('net');

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });

function fakeSmtp(box) {
  return freePort().then((port) => new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let data = ''; let inData = false; let buf = '';
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (inData) { if (line === '.') { inData = false; box.push(data); data = ''; sock.write('250 OK\r\n'); } else data += line + '\n'; }
          else if (/^EHLO|^HELO/i.test(line)) sock.write('250-fake\r\n250 8BITMIME\r\n');
          else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
          else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(port, '127.0.0.1', () => resolve({ srv, port }));
  }));
}

function fakeAi(seen) {
  return freePort().then((port) => new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const j = JSON.parse(b || '{}');
        const sys = Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || '');
        const last = ((j.messages || []).slice(-1)[0] || {}).content || '';
        seen.push({ sys, last });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'Synthèse de test : traitez les impayés en premier.' }] }));
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve({ srv, port }));
  }));
}
module.exports = { fakeSmtp, fakeAi };
