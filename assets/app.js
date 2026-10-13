"use strict";

// ---- helpers -------------------------------------------------------------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + " %");
const intf = (v) => (v == null ? "—" : Number(v).toLocaleString("fr-FR"));
// Audience totale d'une session : audience unique direct ∪ replay quand elle a été
// comptée (attendees_total), sinon le direct seul (repli). Base du taux de présence.
const attTotal = (s) => (s.attendees_total != null ? s.attendees_total : (s.attendees || 0));
// id de dégradé SVG unique par webinar. Sans cela, tous les graphes de la page
// définissent le même id (barGrad/attGrad/csatGrad) : url(#id) pointe vers le
// PREMIER du document, et dès que cet onglet passe en display:none (console
// admin) WebKit/Chrome cessent de peindre le remplissage → barres/aires vides.
const gradId = (base, uid) => `${base}-${String(uid).replace(/[^a-zA-Z0-9_-]/g, "")}`;
// Axe temporel dense : renvoie un prédicat (i) → afficher ou non le repère i.
// On ne garde qu'environ `maxLabels` repères (premier et dernier toujours
// inclus) ; au-delà, les dates pivotées se chevauchent en un amas illisible.
// Les barres/points restent TOUS tracés — seuls les libellés sont espacés.
const tickVisible = (n, maxLabels = 12) => {
  const stride = Math.max(1, Math.ceil(n / maxLabels));
  return (i) => i % stride === 0 || i === n - 1;
};

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(s) {
  const d = parseDate(s);
  return d ? d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";
}
function fmtDateTime(s) {
  const d = parseDate(s);
  return d ? d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}
function fmtDateLong(s) {
  const d = parseDate(s);
  return d ? d.toLocaleString("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}
const ts = (s) => { const d = parseDate(s); return d ? d.getTime() : 0; };

const STATUS = {
  past: { label: "Terminée", cls: "past" },
  upcoming: { label: "À venir", cls: "upcoming" },
  live: { label: "En direct", cls: "live" },
};

// Moyenne CSAT pondérée par le nombre de réponses (null si aucune donnée).
function csatAvg(sessions) {
  let num = 0, den = 0, scale = 5;
  for (const s of sessions) {
    const c = s.csat;
    if (c && typeof c === "object" && c.score != null && c.responses) {
      num += c.score * c.responses;
      den += c.responses;
      scale = c.scale || scale;
    }
  }
  return den ? { score: Math.round((num / den) * 100) / 100, scale, responses: den } : null;
}

// Index session_id -> session, pour la modale de détail.
const byId = new Map();

// État global : données chargées + bornes du filtre par date (null = illimité).
const state = { data: null, from: null, to: null };

// ---- onglets par webinar (vue lecture seule) -----------------------------
// La console admin (admin.js) gère ses PROPRES onglets sur #wtabs (couplés au
// catalogue + aux cases « publier »). Ici on ne construit d'onglets QUE pour la
// vue lecture (index.html + page publiée). On se DÉSACTIVE dès qu'on détecte la
// page admin (présence de #catalog, absent de la vue lecture) → aucun conflit.
const isAdminPage = () => !!document.getElementById("catalog");
let roTab = 0;                 // index du webinar affiché (vue lecture)

// ---- filtre par date -----------------------------------------------------
const sessionDate = (s) => s.started_at || s.estimated_started_at || "";

function filterByDate(sessions, from, to) {
  const lo = from ? new Date(from + "T00:00:00").getTime() : null;
  const hi = to ? new Date(to + "T23:59:59.999").getTime() : null;
  if (lo == null && hi == null) return sessions;
  return sessions.filter((s) => {
    const t = ts(sessionDate(s));
    if (!t) return false;                    // sans date → exclue quand un filtre est posé
    if (lo != null && t < lo) return false;
    if (hi != null && t > hi) return false;
    return true;
  });
}

// Barre de filtre, injectée une seule fois dans #controls (si l'élément existe).
function buildControls() {
  const host = document.getElementById("controls");
  if (!host || host.dataset.ready) return;
  host.dataset.ready = "1";
  host.innerHTML = `
    <div class="filterbar">
      <span class="fb-label">Filtrer par date</span>
      <label class="fb-field">Du <input type="date" id="f-from"></label>
      <label class="fb-field">au <input type="date" id="f-to"></label>
      <label class="fb-field">ou trimestre
        <select id="f-quarter"><option value="">— tous —</option></select>
      </label>
      <button type="button" id="f-reset" class="fb-reset">Réinitialiser</button>
      <span class="fb-count" id="f-count"></span>
    </div>`;
  const from = host.querySelector("#f-from");
  const to = host.querySelector("#f-to");
  const quarter = host.querySelector("#f-quarter");
  // Le trimestre n'est qu'un raccourci : il POSE les deux bornes de date, et tout
  // le reste (filtrage, KPI, synthèse) continue de ne connaître que ces bornes —
  // une seule source de vérité, donc pas de divergence possible entre les deux.
  // Ses options sont remplies par syncQuarters() À CHAQUE RENDU, pas ici : sur la
  // page publique, les sessions n'existent qu'APRÈS le déverrouillage.
  const apply = () => { state.from = from.value || null; state.to = to.value || null; render(); };
  from.addEventListener("change", () => { quarter.value = ""; apply(); });
  to.addEventListener("change", () => { quarter.value = ""; apply(); });
  quarter.addEventListener("change", () => {
    if (!quarter.value) { from.value = to.value = ""; } else {
      const [a, b] = quarter.value.split("|");
      from.value = a; to.value = b;
    }
    apply();
  });
  host.querySelector("#f-reset").addEventListener("click", () => {
    from.value = ""; to.value = ""; quarter.value = ""; state.from = state.to = null; render();
  });
}

// (Re)remplit le sélecteur de trimestre d'après les données CHARGÉES, à chaque
// rendu. Il était peuplé une seule fois, à la construction de la barre de filtre
// — or sur la page publique, à cet instant, state.data.sessions est VIDE : tout
// est encore chiffré. Le sélecteur ne proposait donc que « — tous — » et le filtre
// par trimestre restait sans effet, même après déverrouillage (constaté le
// 2026-10-13 ; avant le verrou global, il ne listait que les trimestres de RFE et
// ignorait ceux où seuls des webinars protégés avaient tourné).
//
// Idempotent, et volontairement guardé par une SIGNATURE : rejoué à chaque
// changement de filtre, il ne doit pas reconstruire les options sous le doigt de
// l'utilisateur — réécrire le <select> remettrait sa valeur à zéro et annulerait
// la sélection qu'on vient de faire.
function syncQuarters() {
  const sel = document.getElementById("f-quarter");
  if (!sel) return;
  const qs = quartersOf(state.data);
  const sig = qs.map((q) => q.label).join("|");
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  const choisi = sel.value;
  sel.innerHTML = `<option value="">— tous —</option>` +
    qs.map((q) => `<option value="${q.from}|${q.to}">${esc(q.label)}</option>`).join("");
  // Conserve le trimestre sélectionné s'il existe toujours. Sinon le select
  // retombe sur « — tous — » tandis que les bornes de date restent affichées :
  // c'est exactement l'état d'un filtrage saisi à la main, donc cohérent.
  sel.value = choisi;
}

// Trimestres réellement présents dans les données, du plus récent au plus ancien.
// On ne propose que ceux qui existent : une liste figée afficherait des trimestres
// vides, et en masquerait d'autres dès que l'historique s'étend.
function quartersOf(data) {
  const vus = new Set();
  for (const s of ((data && data.sessions) || [])) {
    const d = parseDate(sessionDate(s));
    if (d) vus.add(`${d.getFullYear()}-${Math.floor(d.getMonth() / 3) + 1}`);
  }
  const pad = (n) => String(n).padStart(2, "0");
  return [...vus].sort().reverse().map((k) => {
    const [y, q] = k.split("-").map(Number);
    const m0 = (q - 1) * 3 + 1;                  // 1, 4, 7, 10
    const dernier = new Date(y, m0 + 2, 0).getDate();   // dernier jour du 3e mois
    return { label: `T${q} ${y}`, from: `${y}-${pad(m0)}-01`,
             to: `${y}-${pad(m0 + 2)}-${pad(dernier)}` };
  });
}

// ---- rendu (re-jouable : filtre par date, rechargement admin) ------------
function render() {
  const app = document.getElementById("app");
  const data = state.data || {};
  const webinars = data.webinars || [];
  const all = data.sessions || [];
  const sessions = filterByDate(all, state.from, state.to);

  byId.clear();
  for (const s of sessions) byId.set(s.session_id, s);

  const cnt = document.getElementById("f-count");
  if (cnt) cnt.textContent = (state.from || state.to)
    ? `${sessions.length} / ${all.length} session(s)`
    : `${all.length} session(s)`;
  syncQuarters();

  const locked = lockedInfo();
  if (!webinars.length && !locked) {
    app.innerHTML = `<div class="card">Aucun webinar suivi pour le moment.</div>`;
    syncReadonlyTabs();
    return;
  }
  // Page ENTIÈREMENT verrouillée (plus rien en clair, cf. publish.protect_all) :
  // le filtre par date n'a rien à filtrer tant que le blob n'est pas déchiffré.
  // On le retire pour que le formulaire d'accès SOIT la page, et non un encart
  // sous une barre d'outils vide. La console admin n'est jamais dans ce cas (ses
  // données sont locales et en clair) et pilote déjà #controls elle-même.
  const solo = !!locked && !webinars.length;
  if (!isAdminPage()) {
    const host = document.getElementById("controls");
    if (host) host.hidden = solo;
  }
  app.innerHTML = "";
  const views = buildViews(webinars, data.groups || []);
  // Vue d'ensemble EN TÊTE : c'est donc le premier onglet, et la page sur laquelle
  // on atterrit — notamment juste après le déverrouillage.
  if (views.length > 1) app.appendChild(renderOverview(views, sessions));
  for (const v of views) {
    if (v.members) {
      // Groupe : sessions des membres mises en commun. Le webinar passé au rendu
      // est synthétique (id du groupe) — les membres servent au détail par épisode.
      const ids = new Set(v.members.map((m) => m.id));
      app.appendChild(renderWebinar(
        { id: v.group.id, title: v.group.title, type: v.group.type },
        sessions.filter((s) => ids.has(s.event_id)), v.members));
    } else {
      app.appendChild(renderWebinar(v.webinar, sessions.filter((s) => s.event_id === v.webinar.id)));
    }
  }
  // Synthèse cumulée par équipe : utile dès qu'il y a plus d'un webinar à cumuler.
  if (webinars.length > 1) app.appendChild(renderSynthesis(webinars, sessions));
  // Dernier onglet : le verrou, tant que les webinars protégés ne sont pas
  // déchiffrés. Il disparaît de lui-même après déverrouillage (plus de blob).
  if (locked) app.appendChild(renderLock(locked, solo));
  syncReadonlyTabs();
}

// Bandeau « aperçu local ». Les deux pages partagent app.js et le même style :
// rien ne distingue à l'œil l'aperçu local (TOUS les webinars suivis, en clair,
// sans verrou) de la page publique (RFE seul + accès protégé). On le dit donc
// explicitement, sinon on croit voir une fuite sur la page publique alors qu'on
// regarde sa propre machine. Le repère est `published`, posé par publish_site.py
// sur la build publique — pas l'URL : servir le clone public en local reste bien
// la build publique, et ne doit pas afficher ce bandeau.
// Pas de bandeau sur la console admin : son entête l'identifie déjà.
function showLocalBanner() {
  if (isAdminPage()) return;
  const host = document.getElementById("controls");
  if (!host || document.querySelector(".localbanner")) return;
  if (state.data && state.data.published) return;
  const el = document.createElement("div");
  el.className = "wrap localbanner-wrap";
  el.innerHTML =
    `<div class="localbanner">⚠️ <strong>Aperçu local</strong> — tous les webinars ` +
    `suivis sont affichés <strong>en clair, sans verrou</strong>. Ce n'est pas la ` +
    `page publique : là-bas, seuls les webinars publiés <em>en clair</em> s'affichent ` +
    `sans mot de passe, tous les autres sont chiffrés derrière l'accès privé.</div>`;
  host.parentNode.insertBefore(el, host);
}

// Liste des vues à rendre, dans l'ordre : un webinar seul, ou un GROUPE qui en
// réunit plusieurs (cf. `groups` dans webinars.yaml). Un groupe est émis à la
// position de son PREMIER membre, pour que l'ordre d'affichage reste celui des
// webinars ; ses autres membres ne produisent pas de vue séparée.
// Un groupe dont aucun membre n'est présent dans les données est ignoré.
function buildViews(webinars, groups) {
  const byId = new Map();          // event_id → groupe qui le réclame
  for (const g of groups) for (const id of (g.ids || [])) byId.set(id, g);
  const views = [], done = new Set();
  for (const w of webinars) {
    const g = byId.get(w.id);
    if (!g) { views.push({ webinar: w }); continue; }
    if (done.has(g.id)) continue;                 // groupe déjà émis
    done.add(g.id);
    views.push({ group: g, members: webinars.filter((x) => (g.ids || []).includes(x.id)) });
  }
  return views;
}

// (Re)construit la barre d'onglets de la vue lecture à partir des sections
// rendues ci-dessus. Chaque section porte son libellé d'onglet dans
// data-wtab-label : la barre n'a donc pas à savoir CE qu'elle étiquette (webinar
// ou verrou). Rejouée à chaque render() → doit rester idempotente. No-op sur la
// page admin : admin.js pilote #wtabs là-bas.
function syncReadonlyTabs() {
  if (isAdminPage()) return;
  const nav = document.getElementById("wtabs");
  if (!nav) return;                        // page sans barre d'onglets
  const secs = Array.from(document.querySelectorAll("#app .webinar"));
  if (secs.length <= 1) {                  // 0 ou 1 vue → onglets inutiles
    nav.hidden = true;
    secs.forEach((sec) => { sec.hidden = false; });
    return;
  }
  if (roTab >= secs.length) roTab = secs.length - 1;
  nav.hidden = false;
  nav.innerHTML = secs.map((sec, i) => {
    const label = sec.dataset.wtabLabel || `Webinar ${i + 1}`;
    const cls = "wtab" + (i === roTab ? " active" : "") +
      (sec.classList.contains("wlocked") ? " wtab-lock" : "");
    return `<button type="button" class="${cls}" data-rotab="${i}" ` +
      `title="${esc(label)}">${esc(label)}</button>`;
  }).join("");
  secs.forEach((sec, i) => { sec.hidden = (i !== roTab); });
}

// ---- accès protégé (webinars chiffrés) -----------------------------------
// Les webinars non publics sont publiés CHIFFRÉS (AES-256-GCM) dans
// data.protected : le fichier est public, son contenu ne l'est pas. Rien ici ne
// « cache » des données déjà lisibles — sans le bon identifiant + mot de passe,
// il n'y a que du bruit à l'écran comme dans le fichier. Le déchiffrement a lieu
// dans le navigateur via Web Crypto ; le secret ne part sur aucun serveur.

// Blob encore verrouillé, ou null (aucun webinar protégé / déjà déverrouillé).
function lockedInfo() {
  const p = state.data && state.data.protected;
  return p && p.ct ? p : null;
}

// Web Crypto n'existe QUE dans un contexte sécurisé : https:// ou localhost.
// Un fichier ouvert en file:// ne peut donc pas déchiffrer — autant le dire
// clairement plutôt que de laisser croire à un mauvais mot de passe.
const cryptoReady = () => !!(window.crypto && window.crypto.subtle);

const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Déchiffre le blob et fusionne son contenu dans l'état, puis re-rend. L'échec
// est indiscernable d'un mauvais secret par construction (GCM authentifié) :
// on ne distingue donc pas « mot de passe faux » de « données abîmées ».
async function unlockProtected(user, password) {
  const p = lockedInfo();
  if (!p) return { ok: false, error: "Aucune donnée protégée à déverrouiller." };
  if (!cryptoReady()) {
    return { ok: false, error: "Déchiffrement indisponible ici : ouvre la page en https:// (ou depuis localhost)." };
  }
  let payload;
  try {
    const km = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(user + "\n" + password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64bytes(p.salt), iterations: p.iter, hash: p.hash || "SHA-256" },
      km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64bytes(p.iv) }, key, b64bytes(p.ct));
    payload = JSON.parse(new TextDecoder().decode(clear));
  } catch (e) {
    return { ok: false, error: "Identifiant ou mot de passe incorrect." };
  }
  // Fusion : les webinars déchiffrés rejoignent les publics, et le blob disparaît
  // → l'onglet « verrou » n'est plus rendu, les nouveaux onglets apparaissent.
  state.data.webinars = (state.data.webinars || []).concat(payload.webinars || []);
  state.data.sessions = (state.data.sessions || []).concat(payload.sessions || []);
  state.data.groups = mergeGroups(state.data.groups || [], payload.groups || []);
  state.data.audience = { ...(state.data.audience || {}), ...(payload.audience || {}) };
  delete state.data.protected;
  // On atterrit sur le PREMIER onglet, càd la vue d'ensemble : après avoir saisi
  // ses identifiants, on veut voir tous les webinars d'un coup d'œil, pas le
  // rapport détaillé de l'un d'entre eux.
  roTab = 0;
  render();
  return { ok: true };
}

// Recolle les groupes par id. Un même groupe peut arriver en DEUX morceaux — ses
// membres publics dans le fichier en clair, ses membres protégés dans le blob —
// et doit redevenir UN seul onglet : sans cette fusion, buildViews n'émettrait le
// groupe qu'une fois et les membres de l'autre morceau ne seraient rendus nulle part.
function mergeGroups(a, b) {
  const byId = new Map();
  for (const g of a.concat(b)) {
    const prev = byId.get(g.id);
    if (!prev) { byId.set(g.id, { ...g, ids: (g.ids || []).slice() }); continue; }
    for (const id of (g.ids || [])) if (!prev.ids.includes(id)) prev.ids.push(id);
  }
  return Array.from(byId.values());
}

// Section « verrou », avec le formulaire d'accès. Deux situations :
//   - `solo` : plus RIEN n'est publié en clair (publish.protect_all) → c'est la
//     seule section, donc la page d'accueil. Le texte le dit ainsi : il n'y a pas
//     de données « supplémentaires », il n'y a que celles-ci.
//   - sinon : un onglet comme les autres, à côté des webinars publics.
function renderLock(p, solo) {
  const sec = document.createElement("section");
  sec.className = "webinar wlocked" + (solo ? " wlock-solo" : "");
  sec.dataset.wtabLabel = "🔒 Accès privé";
  const n = Number(p.count) || 0;
  sec.innerHTML = `
    <div class="wh"><h2>${solo ? "Accès réservé" : "Accès privé"}</h2></div>
    <div class="lockbox${solo ? " lock-solo" : ""}">
      <p class="lock-intro">
        ${solo
          ? `Ce tableau de bord est <strong>enti&egrave;rement chiffr&eacute;</strong>. ` +
            `Les agr&eacute;gats ${n ? `des <strong>${intf(n)}</strong> webinars suivis ` : ""}` +
            `ne sont lisibles qu'apr&egrave;s identification. Saisis l'identifiant et le ` +
            `mot de passe fournis pour afficher la vue d'ensemble.`
          : `${n ? `<strong>${intf(n)}</strong> webinar(s) suppl&eacute;mentaire(s) sont`
                 : "Des webinars suppl&eacute;mentaires sont"} ` +
            `disponibles sur cette page, <strong>chiffr&eacute;s</strong>. ` +
            `Saisis l'identifiant et le mot de passe fournis pour les consulter.`}
      </p>
      <form class="lock-form" autocomplete="off">
        <label class="lock-field">Identifiant
          <input type="text" name="user" autocomplete="username" required>
        </label>
        <label class="lock-field">Mot de passe
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button type="submit" class="lock-btn">Déverrouiller</button>
      </form>
      <p class="lock-msg" role="alert" aria-live="polite"></p>
      <p class="lock-note muted">
        Le déchiffrement se fait dans ton navigateur : le mot de passe n'est envoyé
        à aucun serveur. Les données restent des agrégats, sans donnée personnelle.
      </p>
    </div>`;
  const form = sec.querySelector(".lock-form");
  const msg = sec.querySelector(".lock-msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector(".lock-btn");
    msg.className = "lock-msg";
    msg.textContent = "Déverrouillage…";
    btn.disabled = true;
    const res = await unlockProtected(form.user.value.trim(), form.password.value);
    if (!res.ok) {                   // en cas de succès, render() a déjà tout remplacé
      btn.disabled = false;
      msg.className = "lock-msg lock-err";
      msg.textContent = res.error;
      form.password.select();
    }
  });
  return sec;
}

// Bascule d'onglet (vue lecture) : masque/affiche sans re-rendre tout #app.
function onReadonlyTabClick(e) {
  const t = e.target.closest(".wtab");
  if (!t || t.dataset.rotab == null) return;
  roTab = Number(t.dataset.rotab);
  document.querySelectorAll("#app .webinar").forEach((sec, i) => { sec.hidden = (i !== roTab); });
  document.querySelectorAll("#wtabs .wtab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.rotab === String(roTab));
  });
}

// ---- load ----------------------------------------------------------------
async function main() {
  const app = document.getElementById("app");
  try {
    const res = await fetch("./data/sessions.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    state.data = await res.json();
  } catch (e) {
    app.innerHTML = `<div class="card error">Données indisponibles pour le moment.</div>`;
    return;
  }

  const upd = document.getElementById("updated");
  if (state.data.generated_at) upd.textContent = "Mis à jour le " + fmtDateTime(state.data.generated_at);

  showLocalBanner();
  buildControls();
  render();

  // Délégation : [data-sid] ouvre le détail d'une session, [data-goto] bascule
  // sur l'onglet d'un webinar (entête de carte de la vue d'ensemble). La session
  // passe en premier — une ligne cliquable vit à l'intérieur d'une carte, et
  // c'est bien son détail qu'on veut en cliquant dessus.
  app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-sid]");
    if (el) {
      const s = byId.get(el.getAttribute("data-sid"));
      if (s) openDetail(s);
      return;
    }
    const go = e.target.closest("[data-goto]");
    if (go) gotoWebinar(go.getAttribute("data-goto"));
  });

  // Onglets de la vue lecture (jamais sur la page admin : admin.js s'en charge).
  const wtabs = document.getElementById("wtabs");
  if (wtabs && !isAdminPage()) wtabs.addEventListener("click", onReadonlyTabClick);
}

// Recharge sessions.json puis re-rend (appelé par la page admin après une
// mise à jour / un recalcul / une suppression). Conserve le filtre en cours.
async function reload() {
  try {
    const res = await fetch("./data/sessions.json", { cache: "no-store" });
    if (res.ok) state.data = await res.json();
  } catch (e) { /* on garde l'état courant */ }
  const upd = document.getElementById("updated");
  if (state.data && state.data.generated_at)
    upd.textContent = "Mis à jour le " + fmtDateTime(state.data.generated_at);
  render();
}

// Exposé pour la page admin (site/admin.html), qui réutilise ce rendu.
window.DASH = { render, reload, state, filterByDate };

// ---- render --------------------------------------------------------------
// Rend le rapport d'UN webinar, ou d'un GROUPE si `members` est fourni (les
// sessions reçues sont alors celles de tous les membres, déjà mises en commun) :
// KPIs et graphes sont cumulés, et un tableau « Détail par épisode » redonne les
// chiffres de chaque membre.
function renderWebinar(w, sessions, members) {
  const past = sessions.filter((s) => s.status === "past")
    .sort((a, b) => ts(a.estimated_started_at) - ts(b.estimated_started_at));
  const upcoming = sessions.filter((s) => s.status === "upcoming")
    .sort((a, b) => ts(a.estimated_started_at) - ts(b.estimated_started_at));

  const totReg = past.reduce((n, s) => n + (s.registrants || 0), 0);
  const totRegUp = upcoming.reduce((n, s) => n + (s.registrants || 0), 0);   // inscrits sessions à venir
  const totRegAll = sessions.reduce((n, s) => n + (s.registrants || 0), 0);  // inscrits toutes sessions
  const totAtt = past.reduce((n, s) => n + (s.attendees || 0), 0);
  const totTotal = past.reduce((n, s) => n + attTotal(s), 0);   // direct + replay (unique)
  const totQ = past.reduce((n, s) => n + (s.questions || 0), 0);
  const avg = totReg ? totTotal / totReg : null;   // taux = (direct + replay) / inscrits
  const csat = csatAvg(past);

  const sec = document.createElement("section");
  sec.className = "webinar";
  sec.dataset.wtabLabel = w.title || w.id || "Webinar";   // libellé de son onglet
  // Webinars réellement couverts par cette section : son propre id, ou ceux des
  // membres pour un groupe. C'est ce que la console admin lit pour savoir sur QUI
  // porte la case « publier » — jamais l'indice de la section, qui ne correspond
  // plus au rang du webinar dès qu'un groupe en réunit plusieurs.
  sec.dataset.wids = (members && members.length
    ? members.map((m) => m.id) : [w.id]).filter(Boolean).join(",");
  sec.innerHTML = `
    <div class="wh">
      <h2>${esc(w.title || w.id)}</h2>
      ${w.type ? `<span class="tag">${esc(w.type)}</span>` : ""}
      ${members && members.length > 1
        ? `<span class="tag tag-grp">${intf(members.length)} webinars</span>` : ""}
    </div>
    <div class="kpis">
      ${kpi("Taux de présence moyen", pct(avg), "passé")}
      ${kpi("Inscrits (cumul passé)", intf(totReg))}
      ${kpi("Inscrits (sessions à venir)", intf(totRegUp))}
      ${kpi("Inscrits (toutes sessions)", intf(totRegAll))}
      ${audienceKpis(w.id)}
      ${kpi("Présents (cumul passé)", intf(totAtt))}
      ${/* « Présents » ne compte QUE le direct, alors que le taux ci-dessus porte sur
            l'audience direct ∪ replay : sans ce KPI, le taux n'est pas retrouvable à
            partir des chiffres affichés (sur RFE : 10 952/16 134 = 67,9 % contre 75,8 %
            affiché), et on conclut à une erreur de calcul. Affiché UNIQUEMENT quand le
            replay a été compté et ajoute quelque chose — sinon il répéterait « Présents »
            à l'identique, et le taux est alors déjà vérifiable. */""}
      ${totTotal !== totAtt
        ? kpi("Audience totale", intf(totTotal), "direct + replay, cumul passé") : ""}
      ${kpi("Questions posées (cumul)", intf(totQ))}
      ${csat ? kpi("Satisfaction (CSAT)", `${csat.score}/${csat.scale}`, `${intf(csat.responses)} rép.`) : ""}
      ${kpi("Sessions passées", intf(past.length))}
      ${kpi("Sessions à venir", intf(upcoming.length))}
    </div>
    <h3>Taux de présence par session</h3>
    ${barChart(past, w.id)}
    <h3>Participants par session (direct + replay)</h3>
    ${attendeesChart(past, w.id)}
    ${csat ? `<h3>Évolution de la satisfaction (CSAT)</h3>${csatChart(past, w.id)}` : ""}
    ${members && members.length > 1
      ? `<h3>Détail par épisode</h3>${episodeTable(members, sessions)}` : ""}
    ${upcoming.length ? `<h3>Sessions à venir</h3>${upcomingList(upcoming)}` : ""}
    <h3>Détail des sessions passées</h3>
    ${table(past.slice().reverse())}
  `;
  return sec;
}

// ---- vue d'ensemble (page d'atterrissage) --------------------------------
// Première section rendue, donc PREMIER onglet : une carte par onglet de webinar
// (ou de série), avec ses chiffres de tête et ses sessions récentes / à venir.
// C'est la page sur laquelle on arrive, en particulier juste après avoir saisi
// l'identifiant et le mot de passe.
//
// Rien n'y est recalculé autrement qu'ailleurs : les cumuls du haut passent par
// aggStats (les formules d'un rapport de webinar) et les lignes reprennent les
// champs de session tels quels. Hérite du filtre par date / trimestre, puisqu'elle
// reçoit les sessions déjà filtrées.

// Fenêtre de sessions affichée par carte. Volontairement courte, et c'est le
// point de la page : les cartes doivent rester comparables d'un coup d'œil, alors
// que RFE compte 49 sessions passées et d'autres webinars trois. Le nombre de
// sessions masquées est affiché (jamais de troncature muette) et l'onglet du
// webinar en donne la liste complète.
const OV_PAST = 3, OV_UP = 4;

const ovMore = (txt) => `<li class="ovmore">${esc(txt)}</li>`;

function renderOverview(views, sessions) {
  const st = aggStats(sessions);
  const nW = views.reduce((n, v) => n + (v.members ? v.members.length : 1), 0);
  const sec = document.createElement("section");
  sec.className = "webinar overview";
  sec.dataset.wtabLabel = "Vue d'ensemble";
  sec.dataset.wids = "";      // pas un webinar : ni case « publier », ni « dispensé par »
  sec.innerHTML = `
    <div class="wh">
      <h2>Vue d'ensemble</h2>
      <span class="tag tag-grp">${intf(nW)} webinars</span>
      <span class="tag">${intf(st.nPast)} sessions passées · ${intf(st.nUp)} à venir</span>
    </div>
    ${/* Cinq tuiles, pas huit : le compte des sessions est un repère de contexte
          (il part dans l'entête ci-dessus), pas un indicateur qu'on surveille. Au
          delà de cinq, la rangée se casse en deux et la hiérarchie se perd —
          alors que tout le détail est à un clic, dans l'onglet du webinar. */""}
    <div class="kpis">
      ${kpi("Taux de présence moyen", pct(st.rate), "passé")}
      ${kpi("Audience totale", intf(st.tot), "direct + replay, cumul passé")}
      ${kpi("Inscrits (cumul passé)", intf(st.reg))}
      ${st.csat ? kpi("Satisfaction (CSAT)", `${st.csat.score}/${st.csat.scale}`,
                      `${intf(st.csat.responses)} rép.`) : ""}
      ${kpi("Inscrits (sessions à venir)", intf(st.regUp))}
    </div>
    <p class="muted ov-intro">
      Cumul de tous les webinars suivis, sur la période filtrée ci-dessus.
      Clique une <strong>session</strong> pour son détail, ou l'<strong>entête d'une
      carte</strong> pour ouvrir le rapport complet du webinar.
    </p>
    <div class="ovgrid">${views.map((v) => ovCard(v, sessions)).join("")}</div>`;
  return sec;
}

function ovCard(view, sessions) {
  const grp = !!view.members;
  const meta = grp ? view.group : view.webinar;
  const ids = (grp ? view.members.map((m) => m.id) : [view.webinar.id]).filter(Boolean);
  const vus = new Set(ids);
  const mine = sessions.filter((s) => vus.has(s.event_id));

  const past = mine.filter((s) => s.status === "past")
    .sort((a, b) => ts(a.estimated_started_at) - ts(b.estimated_started_at));
  // « À venir » inclut une session EN DIRECT : c'est justement le moment où on
  // ouvre cette page, elle ne doit pas en disparaître. Les sessions annulées
  // restent exclues, comme dans tout le reste du dashboard.
  const next = mine.filter((s) => s.status === "upcoming" || s.status === "live")
    .sort((a, b) => ts(a.estimated_started_at) - ts(b.estimated_started_at));

  const reg = past.reduce((n, s) => n + (s.registrants || 0), 0);
  const tot = past.reduce((n, s) => n + attTotal(s), 0);
  // Les COMPTEURS ne portent que sur les sessions à venir au sens strict, pour
  // coïncider exactement avec les KPI du rapport du webinar. Une session en cours
  // n'est pas « à venir » : elle apparaît dans la liste, signalée « en direct ».
  const aVenir = next.filter((s) => s.status === "upcoming");
  const enCours = next.length - aVenir.length;
  const regUp = aVenir.reduce((n, s) => n + (s.registrants || 0), 0);

  const cachees = Math.max(0, past.length - OV_PAST);
  const restantes = Math.max(0, next.length - OV_UP);
  const lignes =
    (cachees ? ovMore(`+ ${intf(cachees)} session(s) passée(s) plus ancienne(s)`) : "") +
    past.slice(-OV_PAST).map((s) => ovRow(s, false)).join("") +
    next.slice(0, OV_UP).map((s, i) => ovRow(s, i === 0)).join("") +
    (restantes ? ovMore(`+ ${intf(restantes)} session(s) à venir`) : "");

  return `<article class="ovcard">
    <header class="ovcard-head" data-goto="${esc(ids.join(","))}"
            title="Ouvrir le rapport complet de ce webinar">
      <h3 class="ovcard-t">${esc(meta.title || meta.id)}</h3>
      <p class="ovcard-sub">
        ${grp ? `<span class="tag tag-grp">${intf(view.members.length)} webinars</span> ` : ""}
        ${intf(past.length)} passée(s) · ${intf(aVenir.length)} à venir${
          enCours ? ` · <strong>en direct</strong>` : ""}
      </p>
      <div class="ovfigs">
        <div class="ovfig">
          <span class="ovfig-v">${pct(reg ? tot / reg : null)}</span>
          <span class="ovfig-l">taux moyen</span>
        </div>
        <div class="ovfig">
          <span class="ovfig-v">${intf(regUp)}</span>
          <span class="ovfig-l">inscrits à venir</span>
        </div>
      </div>
      <span class="ovcard-go" aria-hidden="true">→</span>
    </header>
    <ul class="ovlist">${lignes || ovMore("Aucune session sur la période")}</ul>
  </article>`;
}

// Une ligne = une session, cliquable (même modale que partout ailleurs).
// Session passée : audience / inscrits + taux. Session à venir : inscrits à ce
// jour — le taux n'existe pas encore, et afficher « 0 % » le ferait croire nul.
function ovRow(s, premier) {
  const fini = s.status === "past";
  const live = s.status === "live";
  const badge = live ? `<span class="ovr-badge ovr-live">en direct</span>`
    : (premier && !fini ? `<span class="ovr-badge">prochaine</span>` : "");
  // Session corrigée à la main : signalée ici aussi, sinon le taux de cette ligne
  // passerait pour une mesure (cf. session_overrides dans webinars.yaml).
  const corr = s.manual
    ? ` <span class="corr" title="${esc(s.manual_reason || "donnée corrigée manuellement")}">corrigé</span>`
    : "";
  const chiffres = fini
    ? `<span class="ovr-v">${intf(attTotal(s))}<span class="ovr-u">/${intf(s.registrants)}</span></span>` +
      `<span class="ovr-rate">${pct(s.attendance_rate)}</span>`
    : `<span class="ovr-v">${intf(s.registrants)}<span class="ovr-u"> inscrits</span></span>`;
  return `<li class="ovrow${fini ? "" : " ovrow-up"}${badge ? " ovrow-soon" : ""}"` +
    ` data-sid="${esc(s.session_id)}" title="Voir le détail de la session">` +
    `<span class="ovr-when">${esc(fmtDateTime(s.estimated_started_at))}${corr}</span>` +
    `${badge}<span class="ovr-m">${chiffres}</span></li>`;
}

// Ouvre l'onglet du webinar (ou de la série) couvrant exactement `wids`. On
// retrouve la section par son data-wids — l'identité canonique d'une section,
// déjà utilisée par la console — puis on CLIQUE sur l'onglet correspondant : les
// deux pages gèrent leurs onglets séparément (roTab ici, activeTab dans
// admin.js), et passer par le bouton évite d'en dupliquer la logique.
function gotoWebinar(wids) {
  const secs = Array.from(document.querySelectorAll("#app .webinar"));
  const i = secs.findIndex((s) => s.dataset.wids === wids);
  if (i < 0) return;
  const tab = document.querySelector(
    `#wtabs .wtab[data-rotab="${i}"], #wtabs .wtab[data-tab="${i}"]`);
  if (!tab) return;
  tab.click();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- synthèse cumulée AFS / SME ------------------------------------------
// Agrégats d'un ensemble de sessions, avec EXACTEMENT les formules d'un rapport de
// webinar (cf. renderWebinar) pour que les deux vues ne puissent pas diverger.
function aggStats(sessions) {
  const past = sessions.filter((s) => s.status === "past");
  const up = sessions.filter((s) => s.status === "upcoming");
  const reg = past.reduce((n, s) => n + (s.registrants || 0), 0);
  const tot = past.reduce((n, s) => n + attTotal(s), 0);
  return {
    reg, tot,
    rate: reg ? tot / reg : null,                 // (direct ∪ replay) / inscrits
    regUp: up.reduce((n, s) => n + (s.registrants || 0), 0),
    regAll: sessions.reduce((n, s) => n + (s.registrants || 0), 0),
    att: past.reduce((n, s) => n + (s.attendees || 0), 0),
    q: past.reduce((n, s) => n + (s.questions || 0), 0),
    csat: csatAvg(past),
    nPast: past.length, nUp: up.length,
  };
}

const TEAMS = { afs: "AFS", sme: "SME Services" };

// Vue « Synthèse » : les mêmes KPI qu'un webinar, mais CUMULÉS, d'un côté pour les
// webinars dispensés par AFS, de l'autre par SME. Calculée dans le NAVIGATEUR à
// partir des seules données chargées : sur la page publique elle ne porte donc que
// sur les webinars publiés tant que l'accès privé n'est pas déverrouillé, et sur
// tout ensuite — aucun agrégat des webinars protégés ne fuit en clair.
// Hérite du filtre par date / trimestre, puisqu'elle reçoit les sessions filtrées.
function renderSynthesis(webs, sessions) {
  const byTeam = { afs: [], sme: [], "": [] };
  for (const w of webs) byTeam[TEAMS[w.delivered_by] ? w.delivered_by : ""].push(w);

  // AFS et SME toujours présentes (structure stable, même à zéro) ; « non attribué »
  // seulement s'il en reste, pour qu'aucun webinar ne manque au cumul sans le dire.
  const cols = [{ k: "afs", l: TEAMS.afs }, { k: "sme", l: TEAMS.sme }];
  if (byTeam[""].length) cols.push({ k: "", l: "Non attribué" });
  cols.push({ k: "__t", l: "Total" });

  // `actifs` = webinars ayant au moins une session dans la plage filtrée. C'est ce
  // qu'on compte, et non le nombre d'attributions : sur un trimestre, « 10 webinars
  // AFS » alors que trois seulement ont tourné induirait en erreur. Sans filtre, les
  // deux chiffres coïncident.
  const avecSession = new Set(sessions.map((s) => s.event_id));
  const data = cols.map((c) => {
    const ws = c.k === "__t" ? webs : byTeam[c.k];
    const ids = new Set(ws.map((w) => w.id));
    return { ...c, ws, actifs: ws.filter((w) => avecSession.has(w.id)),
             st: aggStats(sessions.filter((s) => ids.has(s.event_id))) };
  });

  const lignes = [
    ["Webinars actifs sur la période", (d) => intf(d.actifs.length)],
    ["Taux de présence moyen", (d) => pct(d.st.rate), true],
    ["Inscrits (cumul passé)", (d) => intf(d.st.reg)],
    ["Inscrits (sessions à venir)", (d) => intf(d.st.regUp)],
    ["Inscrits (toutes sessions)", (d) => intf(d.st.regAll)],
    ["Présents en direct (cumul passé)", (d) => intf(d.st.att)],
    ["Audience totale (direct + replay)", (d) => intf(d.st.tot)],
    ["Questions posées (cumul)", (d) => intf(d.st.q)],
    ["Satisfaction (CSAT)",
      (d) => (d.st.csat ? `${d.st.csat.score}/${d.st.csat.scale}` : "—")],
    ["Réponses CSAT", (d) => intf(d.st.csat ? d.st.csat.responses : 0)],
    ["Sessions passées", (d) => intf(d.st.nPast)],
    ["Sessions à venir", (d) => intf(d.st.nUp)],
  ];

  const sec = document.createElement("section");
  sec.className = "webinar synthese";
  sec.dataset.wtabLabel = "Synthèse AFS / SME";
  sec.dataset.wids = "";        // pas un webinar : ni case « publier », ni « dispensé par »
  sec.innerHTML = `
    <div class="wh">
      <h2>Synthèse AFS / SME</h2>
      <span class="tag tag-grp">${intf(webs.length)} webinars</span>
    </div>
    <p class="muted synth-intro">
      Mêmes indicateurs qu'un rapport de webinar, cumulés par équipe dispensatrice.
      Suit le filtre par date et par trimestre ci-dessus.
      ${byTeam[""].length ? `<strong>${intf(byTeam[""].length)} webinar(s) non attribué(s)</strong> —
        coche AFS ou SME dans leur onglet de la console pour les ranger.` : ""}
    </p>
    <div class="tablewrap"><table class="syntable">
      <thead><tr><th>Indicateur</th>${
        data.map((d) => `<th class="num${d.k === "__t" ? " syn-tot" : ""}">${esc(d.l)}</th>`).join("")
      }</tr></thead>
      <tbody>${lignes.map(([lbl, f, fort]) => `<tr${fort ? ' class="syn-key"' : ""}>` +
        `<td>${esc(lbl)}</td>` +
        data.map((d) => `<td class="num${d.k === "__t" ? " syn-tot" : ""}">${f(d)}</td>`).join("") +
        `</tr>`).join("")}</tbody>
    </table></div>
    <h3>Détail par webinar</h3>
    ${synthDetail(webs, sessions)}
  `;
  return sec;
}

// Une ligne par webinar : son équipe et ses propres chiffres, pour voir d'où vient
// le cumul et repérer un webinar mal attribué.
function synthDetail(webs, sessions) {
  const rows = webs.map((w) => {
    const st = aggStats(sessions.filter((s) => s.event_id === w.id));
    return { w, st };
  }).sort((a, b) => (b.st.reg - a.st.reg));
  const body = rows.map(({ w, st }) => {
    const t = TEAMS[w.delivered_by];
    return `<tr>
      <td>${esc(w.title || w.id)}</td>
      <td>${t ? `<span class="syn-team syn-${esc(w.delivered_by)}">${esc(t)}</span>`
              : `<span class="syn-team syn-none">non attribué</span>`}</td>
      <td class="num">${intf(st.nPast)}</td>
      <td class="num">${intf(st.reg)}</td>
      <td class="num">${intf(st.tot)}</td>
      <td class="num">${pct(st.rate)}</td>
      <td class="num">${intf(st.q)}</td>
      <td class="num">${st.csat ? `${st.csat.score}/${st.csat.scale}` : "—"}</td>
    </tr>`;
  }).join("");
  return `<div class="tablewrap"><table class="eptable">
    <thead><tr><th>Webinar</th><th>Dispensé par</th>
      <th class="num">Sessions</th><th class="num">Inscrits</th>
      <th class="num">Audience</th><th class="num">Taux</th>
      <th class="num">Questions</th><th class="num">CSAT</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// Tableau récapitulatif d'un groupe : une ligne par webinar membre, avec SES
// propres chiffres — les KPIs et graphes au-dessus étant cumulés, c'est ici qu'on
// compare les épisodes entre eux. Ordre = celui de la config (donc #1, #2, …).
function episodeTable(members, sessions) {
  const rows = members.map((m) => {
    const mine = sessions.filter((s) => s.event_id === m.id);
    const past = mine.filter((s) => s.status === "past");
    const reg = past.reduce((n, s) => n + (s.registrants || 0), 0);
    const tot = past.reduce((n, s) => n + attTotal(s), 0);
    return {
      title: m.title || m.id,
      past: past.length,
      up: mine.filter((s) => s.status === "upcoming").length,
      reg, tot,
      rate: reg ? tot / reg : null,
      q: past.reduce((n, s) => n + (s.questions || 0), 0),
      csat: csatAvg(past),
    };
  });
  const body = rows.map((r) => `<tr>
      <td>${esc(r.title)}</td>
      <td class="num">${intf(r.past)}${r.up ? ` <span class="muted">+${intf(r.up)}</span>` : ""}</td>
      <td class="num">${intf(r.reg)}</td>
      <td class="num">${intf(r.tot)}</td>
      <td class="num">${pct(r.rate)}</td>
      <td class="num">${intf(r.q)}</td>
      <td class="num">${r.csat ? `${r.csat.score}/${r.csat.scale}` : "—"}</td>
    </tr>`).join("");
  return `<div class="tablewrap"><table class="eptable">
    <thead><tr>
      <th>Épisode</th>
      <th class="num" title="Sessions passées (+ à venir)">Sessions</th>
      <th class="num">Inscrits</th>
      <th class="num" title="Direct + replay (audience unique)">Participants</th>
      <th class="num">Taux</th>
      <th class="num">Questions</th>
      <th class="num">CSAT</th>
    </tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// KPI d'audience DÉDOUBLONNÉE, affichés seulement si le calcul à la demande a été
// lancé pour ce périmètre (bouton « 👥 Audience unique » de la console).
// Raison d'être : les KPI « Inscrits » comptent des INSCRIPTIONS, pas des personnes
// — sur la série Guidance, 9 281 inscriptions pour 2 444 personnes. Annoncer le
// premier chiffre comme un nombre de participants le surestime d'un facteur 3,8.
// Le nombre de cabinets vient d'un champ en TEXTE LIBRE : c'est une estimation, et
// la note porte le taux de remplissage pour qu'on sache ce qu'elle vaut.
function audienceKpis(scopeId) {
  const a = ((state.data && state.data.audience) || {})[scopeId];
  if (!a || !a.people) return "";
  const quand = a.computed_at ? `au ${fmtDate(a.computed_at)}` : "";
  let out = kpi("Personnes uniques", intf(a.people),
    [quand, a.people_sum && a.people_sum > a.people
      ? `${intf(a.people_sum)} inscriptions cumulées` : ""].filter(Boolean).join(" · "));
  if (a.firms) {
    const taux = a.firm_filled != null ? `${Math.round(a.firm_filled * 100)} % renseigné` : "";
    out += kpi("Cabinets distincts", intf(a.firms),
      ["estimation", taux, quand].filter(Boolean).join(" · "));
  }
  return out;
}

function kpi(label, value, note) {
  return `<div class="kpi"><div class="kpi-v">${value}</div>` +
    `<div class="kpi-l">${esc(label)}${note ? ` <em>(${esc(note)})</em>` : ""}</div></div>`;
}

function barChart(past, uid) {
  if (!past.length) return `<p class="muted">Aucune session passée pour l'instant.</p>`;
  const bg = gradId("barGrad", uid);
  const W = 820, H = 280, padL = 42, padR = 12, padT = 18, padB = 74;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = past.length, step = iw / n, bw = Math.max(6, Math.min(46, step - 10));
  const showTick = tickVisible(n);

  let grid = "";
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const y = padT + ih - ih * t;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ay">${t * 100}%</text>`;
  });

  let bars = "";
  past.forEach((s, i) => {
    const r = Math.max(0, Math.min(1, s.attendance_rate || 0));
    const h = ih * r;
    const x = padL + i * step + (step - bw) / 2;
    const y = padT + ih - h;
    const d = fmtDate(s.estimated_started_at);
    const cx = (x + bw / 2).toFixed(1);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="url(#${bg})" class="bar" data-sid="${esc(s.session_id)}">` +
      `<title>${esc(d)} — ${pct(s.attendance_rate)} (${intf(attTotal(s))}/${intf(s.registrants)}) · cliquer pour le détail</title></rect>`;
    if (bw >= 22 && h > 16) bars += `<text x="${cx}" y="${(y - 5).toFixed(1)}" class="bv">${Math.round(r * 100)}</text>`;
    if (showTick(i)) {
      const ly = padT + ih + 16;
      bars += `<text x="${cx}" y="${ly}" class="ax" transform="rotate(40 ${cx} ${ly})">${esc(d)}</text>`;
    }
  });

  const defs = `<defs><linearGradient id="${bg}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#00BD57"/><stop offset="100%" stop-color="#006666"/>` +
    `</linearGradient></defs>`;

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="Taux de présence par session">${defs}${grid}${bars}</svg></div>`;
}

// Participants par session : audience TOTALE (présents en direct ∪ spectateurs
// replay), en valeurs absolues, tracée en COURBE (mêmes conventions que csatChart).
// On retombe sur les présents en direct quand le total n'a pas été calculé
// (attendees_total absent, ex. webinar non publié). Le tooltip détaille les deux
// chiffres + le total. Axe Y en entiers à partir de 0. Points cliquables.
// Une seule mesure ne fait pas une courbe : il n'y a rien à relier, et le graphe
// s'affiche alors vide sauf un point flottant — on croit à un bug (c'est arrivé sur
// « Guidance PF2027 » à sa première session). La bonne forme pour une valeur unique
// est une TUILE : le nombre EST le graphique. La courbe revient d'elle-même dès la
// deuxième session, et la mention l'annonce pour que l'absence soit lisible comme
// un état normal et non comme une panne.
function singleValueTile(value, label, sid) {
  return `<div class="chart chart-single"${sid ? ` data-sid="${esc(sid)}"` : ""}>` +
    stat(value, label) +
    `<p class="muted single-hint">Une seule session passée : la courbe apparaîtra ` +
    `à partir de la deuxième.</p></div>`;
}

function attendeesChart(past, uid) {
  if (!past.length) return `<p class="muted">Aucune session passée pour l'instant.</p>`;
  if (past.length === 1) {
    const s = past[0];
    const quand = `session du ${fmtDate(s.estimated_started_at)}`;
    return singleValueTile(intf(attTotal(s)), s.replay != null
      ? `Participants — ${quand} · ${intf(s.attendees)} en direct, ` +
        `${intf(s.replay)} en rattrapage`
      : `Participants en direct — ${quand}`, s.session_id);
  }
  const ag = gradId("attGrad", uid);
  const val = (s) => Math.max(0, attTotal(s));
  const maxV = Math.max(1, ...past.map(val));

  const W = 820, H = 280, padL = 52, padR = 12, padT = 22, padB = 74;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = past.length, step = iw / n;
  const showTick = tickVisible(n);
  const cx = (i) => padL + step * i + step / 2;
  const cy = (v) => padT + ih - ih * (v / maxV);

  let grid = "";
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const y = padT + ih - ih * t;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ay">${intf(Math.round(maxV * t))}</text>`;
  });

  const linePath = past.map((s, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${cy(val(s)).toFixed(1)}`).join(" ");
  const areaPath = `M${cx(0).toFixed(1)},${(padT + ih).toFixed(1)} `
    + past.map((s, i) => `L${cx(i).toFixed(1)},${cy(val(s)).toFixed(1)}`).join(" ")
    + ` L${cx(n - 1).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

  let dots = "";
  past.forEach((s, i) => {
    const v = val(s), x = cx(i), y = cy(v);
    const d = fmtDate(s.estimated_started_at);
    // Si le replay a été compté (replay non null) : les deux chiffres + le total ;
    // sinon on n'a que le direct. `replay` = ceux qui ont RATTRAPÉ en replay sans
    // avoir vu le direct (cf. _replay_and_total) — donc direct + rattrapage = total,
    // sans recoupement. Ne pas écrire « ont vu le replay » : ce serait plus large.
    const tip = s.replay != null
      ? `${esc(d)} — ${intf(v)} au total (audience unique) · ${intf(s.attendees)} en direct · ${intf(s.replay)} ont rattrapé en replay`
      : `${esc(d)} — ${intf(v)} présent(s) en direct`;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" class="att-dot" data-sid="${esc(s.session_id)}">` +
      `<title>${tip} · cliquer pour le détail</title></circle>`;
    if (showTick(i)) {
      dots += `<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" class="av">${intf(v)}</text>`;
      const ly = padT + ih + 16;
      dots += `<text x="${x.toFixed(1)}" y="${ly}" class="ax" transform="rotate(40 ${x.toFixed(1)} ${ly})">${esc(d)}</text>`;
    }
  });

  const defs = `<defs><linearGradient id="${ag}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#3E86FF" stop-opacity=".22"/>` +
    `<stop offset="100%" stop-color="#3E86FF" stop-opacity="0"/></linearGradient></defs>`;
  const areaEl = n > 1 ? `<path d="${areaPath}" fill="url(#${ag})" class="att-area"/>` : "";
  const lineEl = n > 1 ? `<path d="${linePath}" class="att-line"/>` : "";

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="Participants (direct + replay) par session">${defs}${grid}${areaEl}${lineEl}${dots}</svg></div>`;
}

// Courbe d'évolution du CSAT par session (mêmes conventions que barChart).
// Seules les sessions notées sont tracées ; l'axe Y est borné [plancher, échelle]
// — on part d'un plancher propre sous la note la plus basse pour rendre la
// tendance lisible (les CSAT se tiennent en haut de l'échelle) sans jamais
// dépasser le maximum réel. Les points sont cliquables (détail de la session).
function csatChart(past, uid) {
  const pts = past.filter((s) => s.csat && typeof s.csat === "object" && s.csat.score != null);
  if (!pts.length) return `<p class="muted">Pas encore de réponses de satisfaction.</p>`;
  if (pts.length === 1) {              // même raison que pour attendeesChart
    const s = pts[0], c = s.csat;
    return singleValueTile(`${c.score}/${c.scale || 5}`,
      `Satisfaction — session du ${fmtDate(s.estimated_started_at)} · ` +
      `${intf(c.responses)} réponse(s)`, s.session_id);
  }
  const cg = gradId("csatGrad", uid);
  const scale = pts[0].csat.scale || 5;
  const scores = pts.map((s) => s.csat.score);
  const dataMin = Math.min.apply(null, scores);

  const top = scale;
  let bottom = Math.max(0, Math.floor(dataMin - 0.5));
  if (top - bottom < 1) bottom = Math.max(0, top - 1);
  const range = (top - bottom) || 1;
  const tickStep = range <= 2 ? 0.5 : 1;
  const decimals = tickStep < 1 ? 1 : 0;

  const W = 820, H = 280, padL = 42, padR = 12, padT = 22, padB = 74;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = pts.length, step = iw / n;
  const showTick = tickVisible(n);
  const cx = (i) => padL + step * i + step / 2;
  const cy = (v) => padT + ih - ih * ((v - bottom) / range);

  let grid = "";
  for (let t = bottom; t <= top + 1e-9; t += tickStep) {
    const y = cy(t);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ay">${t.toFixed(decimals)}</text>`;
  }

  const linePath = pts.map((s, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${cy(s.csat.score).toFixed(1)}`).join(" ");
  const areaPath = `M${cx(0).toFixed(1)},${(padT + ih).toFixed(1)} `
    + pts.map((s, i) => `L${cx(i).toFixed(1)},${cy(s.csat.score).toFixed(1)}`).join(" ")
    + ` L${cx(n - 1).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

  let dots = "";
  pts.forEach((s, i) => {
    const x = cx(i), y = cy(s.csat.score);
    const d = fmtDate(s.estimated_started_at);
    const resp = s.csat.responses != null ? ` · ${intf(s.csat.responses)} rép.` : "";
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" class="spark-dot" data-sid="${esc(s.session_id)}">` +
      `<title>${esc(d)} — ${String(s.csat.score).replace(".", ",")}/${scale}${resp} · cliquer pour le détail</title></circle>`;
    if (showTick(i)) {
      dots += `<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" class="sv">${String(s.csat.score).replace(".", ",")}</text>`;
      const ly = padT + ih + 16;
      dots += `<text x="${x.toFixed(1)}" y="${ly}" class="ax" transform="rotate(40 ${x.toFixed(1)} ${ly})">${esc(d)}</text>`;
    }
  });

  const defs = `<defs><linearGradient id="${cg}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#00BD57" stop-opacity=".25"/>` +
    `<stop offset="100%" stop-color="#00BD57" stop-opacity="0"/></linearGradient></defs>`;
  const areaEl = n > 1 ? `<path d="${areaPath}" fill="url(#${cg})" class="spark-area"/>` : "";
  const lineEl = n > 1 ? `<path d="${linePath}" class="spark-line"/>` : "";

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="Évolution de la satisfaction CSAT par session">${defs}${grid}${areaEl}${lineEl}${dots}</svg></div>`;
}

function upcomingList(up) {
  return `<ul class="upcoming">` + up.map((s) =>
    `<li data-sid="${esc(s.session_id)}"><span class="u-date">${esc(fmtDateTime(s.estimated_started_at))}</span>` +
    `<span class="u-reg">${intf(s.registrants)} inscrits à ce jour</span></li>`
  ).join("") + `</ul>`;
}

function table(rows) {
  if (!rows.length) return `<p class="muted">—</p>`;
  const body = rows.map((s) => {
    const dur = s.duration_min != null
      ? intf(s.duration_min) + " min" + (s.duration_anomaly ? " ⚠️" : "")
      : "—";
    // Session corrigée à la main (Livestorm n'avait pas enregistré la séance) : on
    // la signale, sinon le chiffre devient indiscernable d'une mesure. Le motif est
    // en infobulle, et le détail direct/replay reste volontairement vide.
    const corr = s.manual
      ? ` <span class="corr" title="${esc(s.manual_reason || "donnée corrigée manuellement")}">corrigé</span>`
      : "";
    return `<tr data-sid="${esc(s.session_id)}">
      <td>${esc(fmtDateTime(s.estimated_started_at))}${corr}</td>
      <td class="num">${intf(s.registrants)}</td>
      <td class="num">${s.manual ? "—" : intf(s.attendees)}</td>
      <td class="num">${pct(s.attendance_rate)}</td>
      <td class="num">${dur}</td>
      <td class="num">${intf(s.questions)}</td>
      <td class="num"><span class="rowcta">voir →</span></td>
    </tr>`;
  }).join("");
  return `<div class="tablewrap"><table>
    <thead><tr><th>Session</th><th class="num">Inscrits</th><th class="num">Présents</th>` +
    `<th class="num">Taux</th><th class="num">Durée</th><th class="num">Questions</th><th class="num"></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// ---- modale de détail ----------------------------------------------------
let dlg = null;

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "detail";
  document.body.appendChild(dlg);
  // Fermeture au clic sur le fond (backdrop).
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  return dlg;
}

function stat(value, label, cls) {
  return `<div class="stat${cls ? " " + cls : ""}"><div class="stat-v">${value}</div>` +
    `<div class="stat-l">${esc(label)}</div></div>`;
}

function csatTile(s) {
  const c = s.csat;
  if (c == null || (typeof c === "object" && c.score == null)) {
    return `<div class="stat full soon"><div class="stat-v">Bientôt disponible</div>` +
      `<div class="stat-l">Satisfaction (CSAT) par session — collecte en cours de mise en place</div></div>`;
  }
  if (typeof c === "object") {
    const scale = c.scale || 5;
    const resp = c.responses != null ? ` · ${intf(c.responses)} réponse(s)` : "";
    return stat(`${c.score}/${scale}`, `Satisfaction (CSAT)${resp}`, "full");
  }
  return stat(`${(c * 100).toFixed(0)} %`, "Satisfaction (CSAT)", "full");
}

function openDetail(s) {
  const d = ensureDialog();
  const st = STATUS[s.status] || { label: s.status || "—", cls: "past" };
  const when = s.started_at || s.estimated_started_at;
  const dur = s.duration_min != null
    ? intf(s.duration_min) + " min" + (s.duration_anomaly ? " ⚠️" : "")
    : "—";
  const attLabel = s.status === "upcoming" ? "Inscrits à ce jour" : "Inscrits";
  // Détail replay : uniquement si le comptage a eu lieu (replay non null, càd
  // session terminée d'un webinar publié). Sinon on n'affiche que le direct.
  // `replay` ne compte que ceux qui ont rattrapé SANS voir le direct : les deux
  // tuiles s'additionnent donc exactement en l'audience totale, sans doublon.
  const hasReplay = s.replay != null;
  const replayTiles = hasReplay
    ? stat(intf(s.replay), "Ont rattrapé en replay") +
      stat(intf(s.attendees_total), "Audience totale (direct + replay)")
    : "";

  d.innerHTML = `
    <div class="dlg-head">
      <button class="dlg-close" aria-label="Fermer" onclick="this.closest('dialog').close()">×</button>
      <h3>${esc(s.event_title || "Session")}</h3>
      <div class="dlg-sub">${esc(fmtDateLong(when))}</div>
      <span class="dlg-badge ${st.cls}">${esc(st.label)}</span>
    </div>
    <div class="dlg-body">
      <div class="stat-grid">
        ${stat(intf(s.registrants), attLabel)}
        ${stat(intf(s.attendees), hasReplay ? "Présents en direct" : "Présents")}
        ${replayTiles}
        ${stat(pct(s.attendance_rate), "Taux de présence")}
        ${stat(dur, "Durée")}
        ${stat(intf(s.questions), "Questions posées")}
        ${stat(esc(st.label), "Statut")}
        ${csatTile(s)}
      </div>
    </div>`;
  if (typeof d.showModal === "function") d.showModal();
  else d.setAttribute("open", "");
}

document.addEventListener("DOMContentLoaded", main);
