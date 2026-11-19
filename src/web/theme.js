// Le thème choisi dans Réglages, posé avant l'affichage (sinon la page clignote).
try {
  const t = localStorage.getItem("clark.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
