'use strict';
// Bibliothèque — recherche intelligente : plein texte tolérant aux fautes, synonymes du vocabulaire contrôlé, filtres facettés, suggestions,
// résultats classés par pertinence, « documents similaires », et questions en langage naturel (« rapports en français depuis 2023 »).
//
// Sécurité : la recherche ne travaille que sur les notices que la personne a le droit de voir (confidentialité, règles d'accès, bloc ouvert avec son mot de passe).
// Les suggestions, les résultats, les facettes, les corrections et les « similaires » sont tous calculés à partir de cette seule liste : rien ne fuit.
// Le texte extrait des documents est stocké chiffré (comme les fichiers).
//
// Langage naturel : l'interprétation se fait par règles (français et anglais), sans service externe, donc sans coût et sans envoi de données.
// L'interprétation par l'IA du plan n'est pas branchée ici ; ce que la règle a compris est affiché à l'utilisateur, qui peut le corriger.
const { db, nowISO } = require('../db');
const A = require('./access');
const T = require('./lib-text');
const X = require('./legal-extra');
const { extractText } = require('./lib-extract');
const { HttpError, cleanText } = require('../util');

const INDEX_PER_REQUEST = 25;
const W = { title: 5, keywords: 4, call: 3, author: 2, summary: 1.5, klass: 1, location: 1, body: 1 };
const TYPE_RULES = [[/\b(livres?|books?|ouvrages?)\b/g, 'book'], [/\b(rapports?|reports?)\b/g, 'report'], [/\b(contrats?|contracts?|conventions? signees?)\b/g, 'contract'], [/\b(normes?|standards?)\b/g, 'standard'], [/\b(materiels?|equipements?|equipment|outils?|machines?)\b/g, 'equipment'], [/\b(supports? numeriques?|digital media)\b/g, 'digital']];
const LANG_RULES = [[/\b(en )?(francais|french)\b/g, 'fr'], [/\b(en |in )?(anglais|english)\b/g, 'en'], [/\b(en )?(allemand|german)\b/g, 'de'], [/\b(en )?(espagnol|spanish)\b/g, 'es']];

/** Comprend les critères d'une phrase : type, année, langue, disponibilité. Renvoie le texte restant et les filtres reconnus. */
function parseNL(raw) {
  let q = ` ${T.norm(raw)} `; const f = {}; const notes = [];
  for (const [re, v] of TYPE_RULES) if (re.test(q)) { f.type = v; q = q.replace(re, ' '); notes.push(['type', v]); }
  for (const [re, v] of LANG_RULES) if (re.test(q)) { f.language = v; q = q.replace(re, ' '); notes.push(['language', v]); }
  let m;
  if ((m = /\b(avant|before|jusqu a|until)\s+((?:19|20)\d{2})\b/.exec(q))) { f.yearTo = Number(m[2]) - (/avant|before/.test(m[1]) ? 1 : 0); q = q.replace(m[0], ' '); notes.push(['yearTo', f.yearTo]); }
  if ((m = /\b(apres|depuis|since|after|a partir de|from)\s+((?:19|20)\d{2})\b/.exec(q))) { f.yearFrom = Number(m[2]) + (/apres|after/.test(m[1]) ? 1 : 0); q = q.replace(m[0], ' '); notes.push(['yearFrom', f.yearFrom]); }
  if (!f.yearFrom && !f.yearTo && (m = /\b(?:en |in |de |of )?((?:19|20)\d{2})\b/.exec(q))) { f.year = Number(m[1]); q = q.replace(m[0], ' '); notes.push(['year', f.year]); }
  if (/\b(disponibles?|available)\b/.test(q)) { f.available = true; q = q.replace(/\b(disponibles?|available)\b/g, ' '); notes.push(['available', true]); }
  else if (/\b(empruntes?|empruntees?|borrowed|loaned|en pret)\b/.test(q)) { f.status = 'loaned'; q = q.replace(/\b(empruntes?|empruntees?|borrowed|loaned|en pret)\b/g, ' '); notes.push(['status', 'loaned']); }
  else if (/\b(perdus?|perdues?|lost)\b/.test(q)) { f.status = 'lost'; q = q.replace(/\b(perdus?|perdues?|lost)\b/g, ' '); notes.push(['status', 'lost']); }
  q = q.replace(/\b(je cherche|je veux|trouve|trouvez|montre|montrez|moi|tous|toutes|les|des|show|find|me|all|the|about|sur|concernant|de|d|en|in|of)\b/g, ' ');
  return { text: q.replace(/\s+/g, ' ').trim(), filters: f, notes };
}

module.exports = function register(router, h) {
  const R = () => h.recordHelpers;
  const U = require('./lib-text');

  /** Indexe (chiffré) le texte des documents liés qui n'ont pas encore d'index à jour ; renvoie { docId: texte }. */
  async function bodies(req, recs) {
    const docs = recs.filter((r) => r.doc_id);
    const out = new Map(); if (!docs.length) return out;
    const ids = docs.map((r) => Number(r.doc_id)); const ph = ids.map(() => '?').join(',');
    const have = new Map((await db.prepare(`SELECT doc_id, n, body FROM lib_doc_text WHERE doc_id IN (${ph})`).all(...ids)).map((x) => [Number(x.doc_id), x]));
    const cur = new Map((await db.prepare(`SELECT id, version, mime FROM lib_docs WHERE id IN (${ph})`).all(...ids)).map((d) => [Number(d.id), d]));
    let budget = INDEX_PER_REQUEST;
    for (const id of ids) {
      const d = cur.get(id); if (!d) continue;
      let row = have.get(id);
      if ((!row || Number(row.n) !== Number(d.version)) && budget > 0) {
        budget--;
        const v = await db.prepare('SELECT data, mime FROM lib_versions WHERE doc_id = ? AND n = ?').get(id, d.version);
        const buf = v ? X.unseal(v.data) : null;
        const text = buf ? extractText(buf, v.mime) : '';
        const stored = X.seal(Buffer.from(text, 'utf8')).toString('base64');
        await db.prepare('INSERT INTO lib_doc_text (doc_id, org_id, n, body, indexed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (doc_id) DO UPDATE SET n = excluded.n, body = excluded.body, indexed_at = excluded.indexed_at').run(id, req.org.id, d.version, stored, nowISO());
        row = { n: d.version, body: stored };
      }
      if (row && Number(row.n) === Number(d.version)) { const b = X.unseal(Buffer.from(row.body, 'base64')); out.set(id, b ? b.toString('utf8') : ''); }
    }
    return out;
  }

  function fieldsOf(r, cls, body) {
    const c = r.class_id ? cls.get(Number(r.class_id)) : null;
    return {
      title: [r.title, r.d_name || ''].join(' '), keywords: R().parseKeywords(r.keywords).join(' '), call: `${r.call_number} ${r.inventory_no}`, author: `${r.author} ${r.publisher}`,
      summary: r.summary, klass: c ? `${c.code} ${c.name}` : '', location: r.location, body: body || '',
    };
  }
  /** Qualité de correspondance d'un mot de la requête avec les mots d'un champ : 1 exact, 0,75 début de mot, 0,6 faute tolérée, 0 sinon. */
  function quality(form, words) {
    let best = 0;
    for (const w of words) {
      if (w === form) return 1;
      if (form.length >= 3 && w.startsWith(form)) best = Math.max(best, 0.75);
      else if (form.length >= 4 && Math.abs(w.length - form.length) <= 2) { const tol = T.tolerance(form); if (tol && T.lev(w, form, tol) <= tol) best = Math.max(best, 0.6); }
    }
    return best;
  }
  /** Extrait court autour de la première occurrence, mots trouvés entre ⟦ ⟧. */
  function snippet(text, forms) {
    if (!text) return '';
    const ws = String(text).split(/\s+/); const set = new Set(forms);
    const hit = ws.findIndex((w) => { const n = T.norm(w); return n && [...set].some((f) => n === f || (f.length >= 3 && n.startsWith(f)) || (f.length >= 4 && T.lev(n, f, T.tolerance(f)) <= T.tolerance(f))); });
    if (hit < 0) return '';
    const from = Math.max(0, hit - 8); const to = Math.min(ws.length, hit + 14);
    return `${from > 0 ? '… ' : ''}${ws.slice(from, to).map((w) => { const n = T.norm(w); return n && [...set].some((f) => n === f || (f.length >= 3 && n.startsWith(f)) || (f.length >= 4 && T.lev(n, f, T.tolerance(f)) <= T.tolerance(f))) ? `⟦${w}⟧` : w; }).join(' ')}${to < ws.length ? ' …' : ''}`;
  }

  router.get('/smart-search', async (req, res) => {
    const q = req.query || {}; const raw = cleanText(String(q.q || ''), 200);
    if (!raw) throw new HttpError(400, 'Indiquez ce que vous cherchez.');
    const vis = await R().visibility(req); const all = await R().visibleRecords(req, vis); const cls = await R().classMap(req.org.id);
    const thes = await h.thesaurus(req.org.id);
    const nl = parseNL(raw);
    const f = { ...nl.filters };
    for (const k of ['type', 'language', 'status', 'conf']) if (q[k]) f[k] = String(q[k]);
    if (q.year) f.year = Number(q.year);
    if (q.available === '1') f.available = true;
    const classSet = q.class ? R().subtree(cls, A.id(q.class, 'Classe invalide.')) : null;
    const tokens = U.words(nl.text);
    const bod = await bodies(req, all);
    // Mots du corpus (pour corriger une faute) et formes admises par mot de la requête (synonymes).
    const docs = all.map((r) => { const fl = fieldsOf(r, cls, bod.get(Number(r.doc_id))); const words = {}; for (const [k, v] of Object.entries(fl)) words[k] = U.words(v, { stop: false }); return { r, fl, words }; });
    const forms = tokens.map((t) => { const set = new Set([t]); for (const e of thes) { const all2 = [e.term, ...e.synonyms].map(U.norm); if (all2.includes(t)) for (const x of all2) for (const y of x.split(' ')) if (y) set.add(y); } return [...set]; });
    const scoreOf = (d, mode) => {
      let total = 0; let matched = 0;
      forms.forEach((fs) => {
        let best = 0;
        for (const [k, w] of Object.entries(W)) for (const form of fs) { const ql = quality(form, d.words[k]); if (ql) best = Math.max(best, ql * w * (form === fs[0] ? 1 : 0.9)); }
        if (best) { matched++; total += best; }
      });
      if (!forms.length) return 1;
      if (mode === 'and' ? matched < forms.length : matched === 0) return 0;
      const nt = U.norm(d.r.title);
      if (nt.includes(U.norm(nl.text)) && nl.text) total += 4;
      if (forms.every((fs) => fs.some((f) => nt.includes(f)))) total += 2;
      return mode === 'and' ? total : total * 0.5;
    };
    let relaxed = false; let scored = docs.map((d) => ({ d, s: scoreOf(d, 'and') })).filter((x) => x.s > 0);
    if (!scored.length && forms.length > 1) { relaxed = true; scored = docs.map((d) => ({ d, s: scoreOf(d, 'or') })).filter((x) => x.s > 0); }
    // Facettes sur l'ensemble trouvé par le texte ; filtres ensuite.
    const yearOk = (r) => (!f.year || Number(r.year) === f.year) && (!f.yearFrom || Number(r.year) >= f.yearFrom) && (!f.yearTo || (r.year && Number(r.year) <= f.yearTo));
    const pass = (r) => (!f.type || r.rtype === f.type) && (!f.language || (r.language || '') === f.language) && (!f.status || r.status === f.status) && (!f.conf || r.confidentiality === f.conf)
      && (!classSet || (r.class_id && classSet.has(Number(r.class_id)))) && yearOk(r) && (!f.available || (r.status === 'available' && Number(r.loanable)));
    const facets = {};
    const count = (fn, label) => { const m = new Map(); for (const x of scored) { const k = fn(x.d.r); if (k !== '' && k !== null) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].map(([value, n]) => ({ value, count: n, label: label ? label(value) : value })).sort((a, b) => b.count - a.count); };
    facets.type = count((r) => r.rtype, (v) => ({ book: 'Livre', document: 'Document', report: 'Rapport', contract: 'Contrat', standard: 'Norme', digital: 'Support numérique', equipment: 'Matériel' }[v] || v));
    facets.class = count((r) => (r.class_id ? String(r.class_id) : ''), (v) => (cls.get(Number(v)) ? `${cls.get(Number(v)).code} ${cls.get(Number(v)).name}` : v));
    facets.year = count((r) => (r.year ? String(r.year) : '')).sort((a, b) => Number(b.value) - Number(a.value));
    facets.language = count((r) => r.language || '');
    facets.status = count((r) => r.status, (v) => ({ available: 'Disponible', loaned: 'Emprunté', reserved: 'Réservé', lost: 'Perdu', withdrawn: 'Retiré' }[v] || v));
    const hits = scored.filter((x) => pass(x.d.r)).sort((a, b) => b.s - a.s || a.d.r.title.localeCompare(b.d.r.title, 'fr'));
    const page = Math.max(1, Number(q.page) || 1); const size = Math.min(50, Math.max(5, Number(q.size) || 20));
    const flat = forms.flat();
    const decorated = await h.decorateRecords(req, hits.slice((page - 1) * size, page * size).map((x) => x.d.r), cls);
    const records = decorated.map((v, i) => { const x = hits[(page - 1) * size + i]; const inBody = x.d.words.body.length > 0 && forms.some((fs) => fs.some((fm) => quality(fm, x.d.words.body) > 0));
      return { ...v, score: Math.round(x.s * 10) / 10, snippet: snippet(x.d.fl.summary, flat) || snippet(x.d.fl.body, flat), inText: inBody }; });
    // « Vouliez-vous dire » : mots de la requête absents du corpus, remplacés par le mot le plus proche.
    let didYouMean = [];
    if (!hits.length && tokens.length) {
      const vocab = new Map(); for (const d of docs) for (const k of ['title', 'keywords', 'author']) for (const w of d.words[k]) vocab.set(w, (vocab.get(w) || 0) + 1);
      for (const e of thes) for (const w of U.words(e.term, { stop: false })) vocab.set(w, (vocab.get(w) || 0) + 1);
      const fix = tokens.map((t) => { if (vocab.has(t)) return t; let best = null; let bd = 99; for (const w of vocab.keys()) { const tol = Math.max(1, T.tolerance(t)); const dd = T.lev(t, w, tol); if (dd <= tol && dd < bd) { best = w; bd = dd; } } return best || t; });
      if (fix.join(' ') !== tokens.join(' ')) didYouMean = [fix.join(' ')];
    }
    res.json({ query: raw, interpreted: { text: nl.text, filters: f, notes: nl.notes }, relaxed, total: hits.length, page, size, records, facets, didYouMean });
  });

  router.get('/smart-search/suggest', async (req, res) => {
    const raw = cleanText(String((req.query || {}).q || ''), 80); const last = U.norm(raw).split(' ').pop();
    if (!last || last.length < 2) return res.json({ suggestions: [] });
    const vis = await R().visibility(req); const all = await R().visibleRecords(req, vis);
    const out = new Map();
    const add = (text, kind, w) => { const k = U.norm(text); if (!out.has(k)) out.set(k, { text, kind, w }); };
    for (const r of all) {
      if (U.norm(r.title).split(' ').some((w) => w.startsWith(last)) || U.norm(r.title).startsWith(U.norm(raw))) add(r.title, 'title', 2);
      for (const k of R().parseKeywords(r.keywords)) if (U.norm(k).startsWith(last)) add(k, 'keyword', 1);
    }
    for (const e of await h.thesaurus(req.org.id)) for (const t of [e.term, ...e.synonyms]) if (U.norm(t).startsWith(last)) add(e.term, 'term', 1.5);
    res.json({ suggestions: [...out.values()].sort((a, b) => b.w - a.w || a.text.localeCompare(b.text, 'fr')).slice(0, 8).map(({ text, kind }) => ({ text, kind })) });
  });

  router.get('/records/:id/similar', async (req, res) => {
    const vis = await R().visibility(req); const base = await R().loadRecord(req, req.params.id, vis);
    const all = (await R().visibleRecords(req, vis)).filter((r) => Number(r.id) !== Number(base.id)); const cls = await R().classMap(req.org.id);
    const kw = (r) => new Set(R().parseKeywords(r.keywords).map(U.norm)); const tw = (r) => new Set(U.words(r.title));
    const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
    const bk = kw(base); const bt = tw(base);
    const scored = all.map((r) => ({ r, s: jac(bk, kw(r)) * 5 + jac(bt, tw(r)) * 3 + (base.class_id && Number(r.class_id) === Number(base.class_id) ? 2 : 0) + (base.author && r.author === base.author ? 1.5 : 0) + (r.rtype === base.rtype ? 0.5 : 0) }))
      .filter((x) => x.s >= 1.5).sort((a, b) => b.s - a.s).slice(0, 8);
    const dec = await h.decorateRecords(req, scored.map((x) => x.r), cls);
    res.json({ similar: dec.map((v, i) => ({ ...v, score: Math.round(scored[i].s * 10) / 10 })) });
  });
};
module.exports.parseNL = parseNL;
