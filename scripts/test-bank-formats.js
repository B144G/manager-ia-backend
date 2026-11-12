'use strict';
// Import des relevés bancaires : OFX, MT940, CAMT.053, Excel (.xlsx) et CSV. Lancez-le avec : node scripts/test-bank-formats.js
const { run } = require('./lib/wave2');
const { zipSync, strToU8 } = require('fflate');

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000<TRNAMT>-15000.00<FITID>A1<NAME>PAIEMENT LOYER<MEMO>JANVIER
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260107<TRNAMT>250000<FITID>A2<NAME>VIREMENT CLIENT MVOGO
</STMTTRN>
<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20260108<TRNAMT>0<FITID>A3<NAME>LIGNE NULLE
</STMTTRN>
<STMTTRN><TRNTYPE>OTHER<DTPOSTED>pas-une-date<TRNAMT>100<FITID>A4<NAME>DATE FAUSSE
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const MT940 = `:20:REL1
:25:12345/678
:28C:1/1
:60F:C260101XAF100000,
:61:2601050105D15000,NTRFNONREF//BANKREF1
:86:PAIEMENT LOYER JANVIER
:61:2601070107C250000,NTRFREFCLIENT
:86:?20VIREMENT?21CLIENT MVOGO
:61:2601090109RC5000,NTRFX
:86:ANNULATION
:62F:C260109XAF330000,
-}`;

const CAMT = `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Ntry><NtryRef>N1</NtryRef><Amt Ccy="XAF">15000.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-01-05</Dt></BookgDt><AddtlNtryInf>PAIEMENT LOYER</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="XAF">250000</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-01-07</Dt></BookgDt><NtryDtls><TxDtls><RmtInf><Ustrd>VIR CLIENT MVOGO &amp; FILS</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="XAF">0</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-01-08</Dt></BookgDt></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
function xlsx(rows, opts = {}) { // petit classeur : colonne A date (style date), B libellé (texte partagé), C montant
  const strings = ['Date', 'Libellé', 'Montant']; const idx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const body = rows.map(([d, l, a], i) => `<row r="${i + 2}"><c r="A${i + 2}" s="1"><v>${d}</v></c><c r="B${i + 2}" t="s"><v>${idx(l)}</v></c><c r="C${i + 2}"><v>${a}</v></c></row>`).join('');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>${body}</sheetData></worksheet>`;
  const ss = `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`;
  const styles = `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="${opts.fmt || 14}"/></cellXfs></styleSheet>`;
  return Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/sharedStrings.xml': strToU8(ss), 'xl/styles.xml': strToU8(styles) })).toString('base64');
}

run('Import des relevés bancaires : OFX, MT940, CAMT.053, Excel, CSV', async ({ check, owner, mem, other, org2, O, ws, dbx, org }) => {
  const FM = require('../src/workspace/acc-bank-formats');
  const AC = `${O}/accounting`; const AC2 = `${ws(org2)}/accounting`;
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND role = 'manager'").run(org);
  let r;

  // ---------- Lecteurs purs ----------
  check('détection : OFX, MT940, CAMT, CSV reconnus d\'après le contenu', FM.sniff(OFX) === 'ofx' && FM.sniff(MT940) === 'mt940' && FM.sniff(CAMT) === 'camt' && FM.sniff('Date;Libellé;Montant\n05/01/2026;Loyer;-15000') === 'csv');
  let p = FM.parseOfx(OFX);
  check('OFX : 2 lignes valides, 2 refusées (montant nul, date fausse)', p.lines.length === 2 && p.invalid.length === 2, p);
  check('OFX : montants signés, dates, libellé NAME+MEMO, référence FITID', p.lines[0].amount === -15000 && p.lines[0].date === '2026-01-05' && p.lines[0].label === 'PAIEMENT LOYER JANVIER' && p.lines[0].reference === 'A1' && p.lines[1].amount === 250000, p.lines);
  p = FM.parseMt940(MT940);
  check('MT940 : 3 lignes, débit négatif, crédit positif, annulation de crédit (RC) négative', p.lines.length === 3 && p.lines[0].amount === -15000 && p.lines[1].amount === 250000 && p.lines[2].amount === -5000, p.lines);
  check('MT940 : dates, libellés (codes ?20 retirés) et références', p.lines[0].date === '2026-01-05' && p.lines[0].label === 'PAIEMENT LOYER JANVIER' && p.lines[0].reference === 'BANKREF1' && p.lines[1].label === 'VIREMENT CLIENT MVOGO' && p.lines[1].reference === 'REFCLIENT', p.lines);
  p = FM.parseCamt(CAMT);
  check('CAMT.053 : 2 lignes valides, 1 refusée (montant nul)', p.lines.length === 2 && p.invalid.length === 1, p);
  check('CAMT.053 : DBIT négatif, CRDT positif, libellés, entité &amp; décodée', p.lines[0].amount === -15000 && p.lines[0].label === 'PAIEMENT LOYER' && p.lines[0].reference === 'N1' && p.lines[1].amount === 250000 && p.lines[1].label === 'VIR CLIENT MVOGO & FILS', p.lines);
  const csv = FM.xlsxToCsv(Buffer.from(xlsx([[serial(2026, 1, 5), 'Loyer; janvier', -15000], [serial(2026, 1, 7), 'Client "Mvogo"', 250000]]), 'base64'));
  check('Excel : dates converties, textes protégés (; et guillemets), montants conservés', csv.split('\n')[1] === '2026-01-05;"Loyer; janvier";-15000' && csv.split('\n')[2] === '2026-01-07;"Client ""Mvogo""";250000', csv);
  let bad = 0; for (const f of [() => FM.xlsxToCsv(Buffer.from('pas un zip')), () => FM.xlsxToCsv(Buffer.alloc(0)), () => FM.xlsxToCsv(Buffer.from(zipSync({ 'a.txt': strToU8('x') })))]) { try { f(); } catch (e) { if (e.status === 400) bad++; } }
  check('Excel : fichiers invalides refusés proprement (400)', bad === 3, bad);
  check('un OFX piégé (DOCTYPE et entités) est lu comme du texte, sans résoudre d\'entité', FM.parseOfx('<!DOCTYPE x [<!ENTITY a "aaaa">]><OFX><STMTTRN><DTPOSTED>20260105<TRNAMT>-10<NAME>&a;\n</STMTTRN></OFX>').lines[0].label === '&a;');

  // ---------- Import par l'API ----------
  r = await owner('POST', `${AC}/bank`, { name: 'Banque de test', glAccount: '521' });
  const bank = r.json.id;
  r = await mem('POST', `${AC}/bank/${bank}/import`, { csv: OFX });
  check('droits : import refusé à un simple membre', r.status === 403, r.status);

  for (const [label, body, n, fmt] of [['OFX', { csv: OFX }, 2, 'ofx'], ['MT940', { csv: MT940 }, 3, 'mt940'], ['CAMT.053', { csv: CAMT }, 2, 'camt'],
    ['Excel', { xlsxBase64: xlsx([[serial(2026, 2, 3), 'Frais bancaires', -2500], [serial(2026, 2, 4), 'Versement client', 80000]]) }, 2, 'xlsx'],
    ['CSV', { csv: 'Date;Libellé;Montant\n10/03/2026;Abonnement;-35000\n11/03/2026;Vente;120000' }, 2, 'csv']]) {
    r = await owner('POST', `${AC}/bank/${bank}/import`, { ...body, dryRun: true });
    check(`${label} : aperçu (format ${fmt}, ${n} lignes valides)`, r.status === 200 && r.json.detected.format === fmt && r.json.valid === n && r.json.preview.length === n, r.json);
    r = await owner('POST', `${AC}/bank/${bank}/import`, body);
    check(`${label} : import de ${n} lignes`, r.status === 201 && r.json.imported === n && r.json.duplicates === 0, r.json);
    r = await owner('POST', `${AC}/bank/${bank}/import`, body);
    check(`${label} : réimport = aucun doublon créé`, r.status === 201 && r.json.imported === 0 && r.json.duplicates === n, r.json);
  }
  r = await owner('GET', `${AC}/bank/${bank}/lines`);
  const ls = r.json.lines || r.json.items || [];
  check('lignes de relevé : 11 au total, montants signés conservés', ls.length === 11 && ls.some((l) => l.amount === -15000) && ls.some((l) => l.amount === 250000) && ls.some((l) => l.amount === -5000) && ls.some((l) => l.amount === 80000), ls.length);

  r = await owner('POST', `${AC}/bank/${bank}/import`, { xlsxBase64: Buffer.from('pas un classeur').toString('base64') });
  check('Excel illisible : 400 avec un message clair', r.status === 400 && /Excel|xlsx|classeur/i.test(r.json.error), r.json);
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv: '   ' });
  check('relevé vide : 400', r.status === 400, r.status);
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv: '<OFX><STMTTRN><DTPOSTED>x<TRNAMT>y\n</STMTTRN></OFX>' });
  check('OFX sans ligne exploitable : 400', r.status === 400, r.status);
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv: 'x'.repeat(1600000) });
  check('fichier trop gros : refusé', r.status === 400 || r.status === 413, r.status);
  r = await other('POST', `${AC2}/bank/${bank}/import`, { csv: OFX });
  check('cloisonnement : le compte bancaire d\'une autre organisation reste introuvable', r.status === 404, r.status);
});
