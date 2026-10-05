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
      <button type="button" id="f-reset" class="fb-reset">Réinitialiser</button>
      <span class="fb-count" id="f-count"></span>
    </div>`;
  const from = host.querySelector("#f-from");
  const to = host.querySelector("#f-to");
  const apply = () => { state.from = from.value || null; state.to = to.value || null; render(); };
  from.addEventListener("change", apply);
  to.addEventListener("change", apply);
  host.querySelector("#f-reset").addEventListener("click", () => {
    from.value = ""; to.value = ""; state.from = state.to = null; render();
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

  const locked = lockedInfo();
  if (!webinars.length && !locked) {
    app.innerHTML = `<div class="card">Aucun webinar suivi pour le moment.</div>`;
    syncReadonlyTabs();
    return;
  }
  app.innerHTML = "";
  for (const v of buildViews(webinars, data.groups || [])) {
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
  // Dernier onglet : le verrou, tant que les webinars protégés ne sont pas
  // déchiffrés. Il disparaît de lui-même après déverrouillage (plus de blob).
  if (locked) app.appendChild(renderLock(locked));
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
    `page publique : elle ne montre que les webinars publiés, les autres étant ` +
    `chiffrés derrière l'accès privé.</div>`;
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
  const fresh = new Set((payload.webinars || []).map((w) => w.id));
  state.data.webinars = (state.data.webinars || []).concat(payload.webinars || []);
  state.data.sessions = (state.data.sessions || []).concat(payload.sessions || []);
  state.data.groups = mergeGroups(state.data.groups || [], payload.groups || []);
  delete state.data.protected;
  // On atterrit sur le premier onglet contenant un webinar fraîchement déverrouillé
  // (calculé sur les VUES, pas sur les webinars : un groupe en réunit plusieurs).
  const views = buildViews(state.data.webinars, state.data.groups);
  const idx = views.findIndex((v) => v.members
    ? v.members.some((m) => fresh.has(m.id)) : fresh.has(v.webinar.id));
  roTab = idx >= 0 ? idx : 0;
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

// Section « verrou » : un onglet comme un autre, avec le formulaire d'accès.
function renderLock(p) {
  const sec = document.createElement("section");
  sec.className = "webinar wlocked";
  sec.dataset.wtabLabel = "🔒 Accès privé";
  const n = Number(p.count) || 0;
  sec.innerHTML = `
    <div class="wh"><h2>Accès privé</h2></div>
    <div class="lockbox">
      <p class="lock-intro">
        ${n ? `<strong>${intf(n)}</strong> webinar(s) suppl&eacute;mentaire(s) sont` : "Des webinars suppl&eacute;mentaires sont"}
        disponibles sur cette page, <strong>chiffr&eacute;s</strong>.
        Saisis l'identifiant et le mot de passe fournis pour les consulter.
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

  // Délégation : tout élément [data-sid] ouvre le détail de la session.
  app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-sid]");
    if (!el) return;
    const s = byId.get(el.getAttribute("data-sid"));
    if (s) openDetail(s);
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
    return `<tr data-sid="${esc(s.session_id)}">
      <td>${esc(fmtDateTime(s.estimated_started_at))}</td>
      <td class="num">${intf(s.registrants)}</td>
      <td class="num">${intf(s.attendees)}</td>
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
