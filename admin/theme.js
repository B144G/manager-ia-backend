'use strict';
// Thème : appliqué avant l'affichage pour éviter tout éclair (script externe : la CSP de /admin interdit les scripts en ligne).
(function () {
  try { var t = localStorage.getItem('adm-theme'); if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* stockage indisponible : thème du système */ }
})();
