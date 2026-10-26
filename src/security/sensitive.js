'use strict';
// Table centrale des actions sensibles de l'espace de travail : toute réussite est inscrite au journal d'audit, SANS toucher au code de chaque route.
// Pour surveiller une nouvelle action, ajoutez une ligne ici : [méthode, chemin après /api/ws/orgs/<id>, action, gravité].
const audit = require('./audit');

const TABLE = [
  ['DELETE', /^\/?$/, 'org.delete', 'critical'],
  ['PUT', /^\/?$/, 'org.update', 'info'],
  ['PUT', /^\/members\/\d+$/, 'member.role_change', 'high'],
  ['DELETE', /^\/members\/\d+$/, 'member.remove', 'high'],
  ['POST', /^\/invites$/, 'invite.create', 'warn'],
  ['DELETE', /^\/invites\/[^/]+$/, 'invite.revoke', 'info'],
  ['POST', /^\/branches$/, 'branch.create', 'info'],
  ['DELETE', /^\/branches\/\d+$/, 'branch.delete', 'warn'],
  ['POST', /^\/integrations\/keys$/, 'apikey.create', 'high'],
  ['DELETE', /^\/integrations\/keys\/\d+$/, 'apikey.revoke', 'warn'],
  ['POST', /^\/integrations\/webhooks$/, 'webhook.create', 'warn'],
  ['PUT', /^\/integrations\/webhooks\/\d+$/, 'webhook.update', 'info'],
  ['DELETE', /^\/integrations\/webhooks\/\d+$/, 'webhook.delete', 'warn'],
  ['PUT', /^\/sales\/whatsapp$/, 'channel.whatsapp_credentials', 'high'],
  ['POST', /^\/sales\/whatsapp\/embedded\/complete$/, 'channel.whatsapp_embedded', 'high'],
  ['DELETE', /^\/sales\/whatsapp$/, 'channel.whatsapp_disconnect', 'warn'],
  ['POST', /^\/sales\/wa-qr\/start$/, 'channel.wa_qr_start', 'high'],
  ['POST', /^\/sales\/wa-qr\/pairing$/, 'channel.wa_qr_pairing', 'high'],
  ['POST', /^\/sales\/wa-qr\/stop$/, 'channel.wa_qr_stop', 'warn'],
  ['PUT', /^\/sales\/meta$/, 'channel.meta_credentials', 'high'],
  ['DELETE', /^\/sales\/meta$/, 'channel.meta_disconnect', 'warn'],
  ['PUT', /^\/sales\/settings$/, 'sales.settings_change', 'info'],
  ['PUT', /^\/accounting\/settings$/, 'accounting.settings_change', 'warn'],
  ['POST', /^\/accounting\/entries\/\d+\/reverse$/, 'accounting.reverse_entry', 'warn'],
  ['GET', /^\/accounting\/export\.csv$/, 'accounting.export', 'info'],
  ['POST', /^\/mail\/send$/, 'mail.send', 'info'],
];

/** À monter sur /api/ws/orgs (avant le routeur de l'espace de travail). */
function middleware(req, res, next) {
  const m = /^\/(\d+)(\/.*)?$/.exec(req.path);
  if (!m) return next();
  const rest = (m[2] || '/').replace(/\/+$/, '') || '/';
  const hit = TABLE.find(([method, rx]) => method === req.method && rx.test(rest === '/' ? '' : rest));
  if (hit) {
    const orgId = Number(m[1]); const target = req.originalUrl.split('?')[0].slice(0, 160);
    res.on('finish', () => { if (res.statusCode < 400) audit.record(req, hit[2], { orgId, target, severity: hit[3] }); });
  }
  return next();
}

module.exports = { middleware, TABLE };
