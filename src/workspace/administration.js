'use strict';
// Module « Administration » : organigramme et responsabilités, procédures, GED et archives, circuits de validation, contrôle interne,
// moyens généraux, contrats et conformité, reporting. Un fichier par grande fonction (adm-*.js), tables adm_ (src/migrations/administration.js).
// Les RÉUNIONS sont dans le module Réunions (lu seulement) et le management par objectifs dans RH talents (lu seulement s'il est présent).
const express = require('express');
const A = require('./access');
const L = require('./adm-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });

router.get('/settings', async (req, res) => {
  const cfg = await L.getConfig(req.org.id);
  const mem = await L.members(req.org.id);
  const owner = req.member.role === 'owner';
  res.json({ settings: owner ? cfg : { distinct: cfg.distinct, contractAlertDays: cfg.contractAlertDays, complianceAlertDays: cfg.complianceAlertDays, sopReminderDays: cfg.sopReminderDays, docAlertDays: cfg.docAlertDays, assetAlertDays: cfg.assetAlertDays }, me: { userId: req.user.id, role: req.member.role, perms: L.permsOf(req, cfg) }, members: mem.map((m) => ({ userId: m.userId, name: m.name, role: m.role, title: m.title })), permKeys: L.PERM_KEYS, isOwner: owner });
});
router.put('/settings', A.need('owner'), async (req, res) => {
  const cfg = await L.saveConfig(req, req.body || {});
  res.json({ settings: cfg });
});

router.use('/org', require('./adm-org').router);
router.use('/sops', require('./adm-sop').router);
router.use('/docs', require('./adm-docs').router);
router.use('/flow', require('./adm-flow').router);
router.use('/control', require('./adm-control').router);

router.use((req, res) => { throw new HttpError(404, 'Page introuvable.'); });
module.exports = { router };
