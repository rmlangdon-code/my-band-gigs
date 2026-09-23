const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("mbg.token") || "";
let state = { currentUserId: "", isAdmin: false, users: [], bands: [], memberships: [], events: [], availability: {}, activity: [], currentBandId: "all" };
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let editingEventId = null;
let upcomingShown = 10;
let upcomingFilter = "all";
let didDeepLink = false;
let duplicating = false;

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function showInviteLink(url) {
  const box = $("inviteOut");
  box.style.display = "block";
  box.innerHTML = `<div>Link copied. Paste it in a text.</div><button class="btn" type="button" id="copyInviteBtn" style="margin-top:8px">Copy link again</button>`;
  navigator.clipboard?.writeText(url);
  $("copyInviteBtn").onclick = () => { navigator.clipboard?.writeText(url); toast("Link copied"); };
}
function currentUser() { return state.users.find(u => u.id === state.currentUserId) || { name: "" }; }
function currentBand() {
  if (state.currentBandId === "all") return { id: "all", name: "All bands" };
  return state.bands.find(b => b.id === state.currentBandId) || { name: "" };
}
function myBandIds() {
  return [...new Set(state.memberships.filter(m => m.userId === state.currentUserId).map(m => m.bandId))];
}
function isMergedView() { return state.currentBandId === "all"; }
function isAdmin() {
  const ids = isMergedView() ? myBandIds() : [state.currentBandId];
  return state.memberships.some(m => m.userId === state.currentUserId && ids.includes(m.bandId) && m.role === "admin");
}
function firstName(user) { return (user?.firstName || user?.name || "?").split(" ")[0]; }
function displayName(user) {
  const f = (user?.firstName || "").trim();
  const l = (user?.lastName || "").trim();
  if (f || l) return `${f} ${l}`.trim();
  return (user?.name || "?").trim();
}
function bandShort(bandId) { return state.bands.find(b => b.id === bandId)?.short || ""; }
function eventLabel(e) {
  const abbr = bandShort(e.bandId);
  const title = (e.title || "").trim();
  if (!abbr) return title;
  const prefix = abbr + " - ";
  if (title.toLowerCase().startsWith(abbr.toLowerCase() + " -") || title.toLowerCase().startsWith(abbr.toLowerCase() + " –")) return title;
  return prefix + title;
}
function bandMembers(bandId) {
  const ids = bandId === "all" ? myBandIds() : [bandId];
  const seen = new Set();
  return state.memberships.filter(m => ids.includes(m.bandId)).map(m => {
    if (seen.has(m.userId)) return null;
    seen.add(m.userId);
    return { ...m, user: state.users.find(u => u.id === m.userId) };
  }).filter(m => m && m.user);
}
function eventsForBand(bandId) {
  const ids = bandId === "all" ? myBandIds() : [bandId];
  return state.events.filter(e => ids.includes(e.bandId)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
function normDate(d) { return d ? String(d).slice(0, 10) : ""; }
function getAvail(bandId, userId, iso) {
  if (bandId === "all") {
    const marks = myBandIds().map(id => state.availability[`${id}:${userId}:${iso}`]).filter(Boolean);
    if (marks.includes("UNAVAILABLE")) return "UNAVAILABLE";
    if (marks.includes("AVAILABLE")) return "AVAILABLE";
    return "";
  }
  return state.availability[`${bandId}:${userId}:${iso}`] || "";
}
function toISODate(y, m, d) { return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }
function parseMDY(s) {
  const m = String(s||"").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;
}
function fillBdaySelects(iso) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const yNow = new Date().getFullYear();
  let y = yNow - 30, m = 1, d = 1;
  const norm = String(iso || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
    y = +norm.slice(0,4); m = +norm.slice(5,7); d = +norm.slice(8,10);
  }
  $("profBdayM").innerHTML = months.map((n,i) => `<option value="${String(i+1).padStart(2,"0")}">${n}</option>`).join("");
  $("profBdayD").innerHTML = Array.from({length:31}, (_,i) => `<option value="${String(i+1).padStart(2,"0")}">${i+1}</option>`).join("");
  $("profBdayY").innerHTML = Array.from({length:90}, (_,i) => {
    const yy = yNow - 12 - i;
    return `<option value="${yy}">${yy}</option>`;
  }).join("");
  $("profBdayM").value = String(m).padStart(2,"0");
  $("profBdayD").value = String(d).padStart(2,"0");
  $("profBdayY").value = String(y);
}
function bdayFromSelects() {
  if (!$("profBdayY") || !$("profBdayY").value) return "";
  return `${$("profBdayY").value}-${$("profBdayM").value}-${$("profBdayD").value}`;
}
function formatMDY(iso) {
  if (!iso) return "";
  const [y,m,d] = String(iso).slice(0,10).split("-");
  return `${m}/${d}/${y}`;
}

function timeOptions() {
  const out = [];
  for (let i = 0; i < 48; i++) {
    const h24 = Math.floor(i / 2);
    const mi = i % 2 ? "30" : "00";
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h = h24 % 12 || 12;
    out.push(h + ":" + mi + " " + ampm);
  }
  return out;
}
function fillTimeSelect(sel, value) {
  if (!sel) return;
  const opts = timeOptions();
  let v = value || "";
  if (v && !opts.includes(v)) opts.unshift(v);
  sel.innerHTML = opts.map(t => `<option value="${t}">${t}</option>`).join("");
  sel.value = v && opts.includes(v) ? v : (v || "7:00 PM");
}

function formatTime24to12(t) {
  if (!t) return "";
  const [h0, mi] = t.split(":");
  let h = parseInt(h0, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mi} ${ampm}`;
}
function parse12to24(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return "19:00";
  let h = parseInt(m[1], 10);
  const mi = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2,"0")}:${mi}`;
}


function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    const { key } = await api("/api/push/key");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    });
    await api("/api/push/subscribe", { method: "POST", body: { subscription: sub } });
  } catch (err) { console.log("push", err); }
}
function openDeepLink() {
  const q = new URLSearchParams(location.search);
  const eventId = q.get("event");
  const date = q.get("date");
  if (eventId && state.events.some(e => e.id === eventId)) openEventModal(null, eventId);
  else if (date) {
    const [y,m] = date.split("-");
    if (y && m) { viewYear = +y; viewMonth = +m - 1; renderCalendar(); }
  }
}

async function loadState() {
  const data = await api("/api/state");
  if (data.events) data.events = data.events.map(e => ({ ...e, date: normDate(e.date) }));
  state = { ...state, ...data, currentBandId: state.currentBandId || "all" };
  if (state.currentBandId !== "all" && !state.bands.some(b => b.id === state.currentBandId)) state.currentBandId = "all";
  document.body.classList.toggle("is-admin", isAdmin());
  renderAll();
  enablePush();
}

function renderAuth() {
  $("authScreen").style.display = token ? "none" : "grid";
  $("appScreen").style.display = token ? "block" : "none";
}
function renderBands() {
  const items = [{ id: "all", name: "All bands" }, ...state.bands.map(b => ({ id: b.id, name: b.name }))];
  if ($("bands")) {
    $("bands").innerHTML = items.map(b =>
      `<button class="band-item ${state.currentBandId === b.id ? "active" : ""}" data-band="${b.id}"><strong>${b.name}</strong></button>`
    ).join("");
  }
  const showAdminBand = isAdmin() && state.currentBandId !== "all";
  if ($("editAbbrBtn")) $("editAbbrBtn").style.display = showAdminBand ? "" : "none";
  if ($("deleteBandBtn")) $("deleteBandBtn").style.display = showAdminBand ? "" : "none";
}
function renderCalendar() {
  const y = viewYear, m = viewMonth;
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  $("monthLabel").textContent = first.toLocaleString("en-US", { month: "long", year: "numeric" });
  $("memberHint").style.display = "block";
  const events = eventsForBand(state.currentBandId);
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push({ date: new Date(y, m, -startDow + i + 1), out: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(y, m, d), out: false });
  while (cells.length % 7) {
    const last = cells[cells.length - 1].date;
    const n = new Date(last); n.setDate(n.getDate() + 1);
    cells.push({ date: n, out: true });
  }
  const todayISO = toISODate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const admin = isAdmin();
  $("days").innerHTML = cells.map(({ date, out }) => {
    const iso = toISODate(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEvents = events.filter(e => normDate(e.date) === iso);
    const roster = bandMembers(state.currentBandId);
    let extra = "";
    if (admin) {
      let inn = 0, outn = 0;
      roster.forEach(mem => {
        const status = getAvail(state.currentBandId, mem.user.id, iso);
        if (status === "AVAILABLE") inn++;
        if (status === "UNAVAILABLE") outn++;
      });
      extra = `<div class="glance" data-roster="both" data-date="${iso}">${inn} in · ${outn} out</div>`;
    }
    const mine = getAvail(state.currentBandId, state.currentUserId, iso);
    const fill = !out
      ? (mine === "AVAILABLE" ? "filled-in" : mine === "UNAVAILABLE" ? "filled-out" : "")
      : "";
    const firstEvent = dayEvents[0]?.id || "";
    return `<div class="day ${out ? "out" : ""} ${iso === todayISO ? "today" : ""} ${fill}" data-date="${iso}" data-first-event="${firstEvent}">
      <div class="n">${date.getDate()}</div>
      ${dayEvents.slice(0, 2).map(e => `<span class="chip ${e.type}" data-eid="${e.id}">${eventLabel(e)}</span>`).join("")}
      ${out ? "" : extra}
    </div>`;
  }).join("");
}
function renderUpcoming() {
  document.querySelectorAll(".upcoming-filter").forEach(b => b.classList.toggle("on", b.dataset.upfilter === upcomingFilter));
  const today = toISODate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  let all = eventsForBand(state.currentBandId).filter(e => e.date >= today);
  if (upcomingFilter === "mine") all = all.filter(e => getAvail(e.bandId, state.currentUserId, e.date) === "AVAILABLE");
  const upcoming = all.slice(0, upcomingShown);
  const admin = isAdmin();
  const more = all.length > upcomingShown
    ? `<button class="btn" id="showMoreUpcoming" style="width:100%;margin-top:8px">Show more (${all.length - upcomingShown})</button>`
    : "";
  $("upcoming").innerHTML = upcoming.length ? upcoming.map(e => `
    <div class="event" data-eid="${e.id}">
      <h3 class="${e.type}">${eventLabel(e)}</h3>
      <div class="meta">${e.type.toUpperCase()} · ${formatMDY(e.date)} · ${formatTime24to12(e.start)} – ${formatTime24to12(e.end)}</div>
      <div class="meta">${e.venue || "Venue TBD"}</div>
      ${admin ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn" data-edit="${e.id}">Edit</button>
        <button class="btn" data-dup="${e.id}">Duplicate</button>
        <button class="btn btn-danger" data-del="${e.id}">Delete</button>
      </div>` : ""}
    </div>`).join("") + more : `<div class="hint">No upcoming events.</div>`;
}
function renderMembers() {
  if (!$("members")) return;
  const admin = isAdmin();
  $("members").innerHTML = bandMembers(state.currentBandId).map(m => {
    const you = m.user.id === state.currentUserId ? " (you)" : "";
    const full = [m.user.firstName || m.user.name, m.user.lastName].filter(Boolean).join(" ");
    const bday = m.user.birthday ? formatMDY(String(m.user.birthday).slice(0,10)) : "";
    const phone = m.user.phone || "";
    const email = m.user.email || "";
    const first = (m.user.firstName || (m.user.name || "").split(" ")[0] || "").trim();
    const last = (m.user.lastName || (m.user.name || "").split(" ").slice(1).join(" ") || "").trim();
    const bits = [first + you, last, phone, email, bday].filter(Boolean);
    const btns = admin && m.user.id !== state.currentUserId
      ? `<div style="margin:4px 0 8px;display:flex;gap:6px">
           <button class="btn" data-edit-member="${m.user.id}">Edit</button>
           <button class="btn btn-danger" data-del-member="${m.user.id}">Remove</button>
         </div>` : "";
    return `<div class="event" style="cursor:default"><div class="meta">${bits.join(" · ")}</div>${btns}</div>`;
  }).join("") || `<div class="meta">No members yet.</div>`;
  const adminBands = state.bands.filter(b =>
    state.memberships.some(m => m.userId === state.currentUserId && m.bandId === b.id && m.role === "admin")
  );
  $("inviteBands").innerHTML = adminBands.map(b =>
    `<label style="display:block;margin:4px 0"><input type="checkbox" class="invite-band" value="${b.id}" checked> ${b.name}</label>`
  ).join("");
}
function renderActivity() {
  const ids = isMergedView() ? myBandIds() : [state.currentBandId];
  const items = state.activity.filter(a => ids.includes(a.bandId)).slice(0, 10);
  $("activity").innerHTML = items.length
    ? items.map(a => `<div>${formatMDY(String(a.at).slice(0,10))} · ${a.message}</div>`).join("")
    : `<div>No alerts yet.</div>`;
}
function renderAll() {
  renderAuth();
  if (!token) return;
  $("who").textContent = currentUser().name + (isAdmin() ? " · admin" : "");
  $("bandName").textContent = currentBand().name;
  document.body.classList.toggle("is-admin", isAdmin());
  renderBands();
  renderCalendar();
  renderUpcoming();
  renderMembers();
}


async function loadEventAlerts(eventId) {
  const box = $("evAlerts");
  if (!box) return;
  if (!eventId) { box.style.display = "none"; box.innerHTML = ""; return; }
  try {
    const rows = await api("/api/events/" + eventId + "/alerts");
    if (!rows.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    box.style.display = "block";
    box.innerHTML = "<h3>Recent Alerts</h3><ul>" + rows.map(r => {
      const when = r.at ? formatMDY(String(r.at).slice(0,10)) : "";
      return `<li>${r.message}</li>`;
    }).join("") + "</ul>";
    api("/api/events/" + eventId + "/alerts/seen", { method: "POST" }).catch(() => {});
  } catch { box.style.display = "none"; }
}

let notesEventId = null;
function noteAuthor(n) {
  return displayName({ firstName: n.firstName, lastName: n.lastName, name: n.name });
}
async function loadEventNotes(eventId) {
  notesEventId = eventId || null;
  const box = $("evNotesList");
  if (!box) return;
  if (!eventId) { box.innerHTML = ""; return; }
  try {
    const rows = await api("/api/events/" + eventId + "/notes");
    box.innerHTML = rows.length ? rows.map(n => {
      const mine = n.userId === state.currentUserId;
      const can = mine || isAdmin();
      return `<div class="note-item" data-note="${n.id}">
        <div class="meta"><strong>${noteAuthor(n)}</strong> writes:</div>
        <div class="note-text">${(n.message || "").replace(/</g,"&lt;")}</div>
        ${can ? `<div style="margin-top:4px;display:flex;gap:6px">
          <button class="btn" data-note-edit="${n.id}">Edit</button>
          <button class="btn btn-danger" data-note-del="${n.id}">Delete</button>
        </div>` : ""}
      </div>`;
    }).join("") : `<div class="hint">No notes yet.</div>`;
  } catch { box.innerHTML = ""; }
}
function openEventModal(dateISO, eventId, asCopy) {
  const admin = isAdmin();
  if (!admin && !eventId) return;
  const ids = myBandIds();
  if (!ids.length) { toast("Add a band first."); return; }
  editingEventId = asCopy ? null : (eventId || null);
  duplicating = !!asCopy;
  const ev = state.events.find(e => e.id === eventId);
  $("modalTitle").textContent = !admin ? "Event details" : (asCopy ? "Duplicate event" : (ev ? "Edit event" : "Add gig or rehearsal"));
  ["evBand","evTitle","evType","evDate","evStart","evEnd","evVenue"].forEach(id => { if ($(id)) $(id).disabled = !admin; });
  $("saveEvent").style.display = admin ? "" : "none";
  if ($("deleteEventBtn")) $("deleteEventBtn").style.display = admin && editingEventId ? "" : "none";
  if ($("dupEventBtn")) $("dupEventBtn").style.display = admin && eventId && !asCopy ? "" : "none";
  $("evBand").innerHTML = ids.map(id => {
    const b = state.bands.find(x => x.id === id);
    return b ? `<option value="${b.id}">${b.name}</option>` : "";
  }).join("");
  $("evBand").value = ev?.bandId || (isMergedView() ? ids[0] : state.currentBandId) || ids[0];
  $("evTitle").value = ev?.title || "";
  $("evType").value = ev?.type || "gig";
  const isoDate = ev?.date || dateISO || toISODate(viewYear, viewMonth, 1);
  $("evDate").type = "text";
  $("evDate").readOnly = !admin;
  $("evDate").value = formatMDY(isoDate);
  if ($("evDateISO")) $("evDateISO").value = isoDate;
  if ($("evDateBtn")) $("evDateBtn").style.display = admin ? "" : "none";
  fillTimeSelect($("evStart"), ev ? formatTime24to12(ev.start) : "7:00 PM");
  fillTimeSelect($("evEnd"), ev ? formatTime24to12(ev.end) : "10:00 PM");
  $("evVenue").value = ev?.venue || "";
  const availDate = ev?.date || dateISO || $("evDate").value;
  const mine = getAvail(ev?.bandId || $("evBand").value || state.currentBandId, state.currentUserId, availDate);
  const bandForAvail = ev?.bandId || $("evBand").value || state.currentBandId;
  if ($("evLineup")) {
    const roster = bandMembers(bandForAvail === "all" ? state.currentBandId : bandForAvail);
    const ins = [], outs = [];
    roster.forEach(mem => {
      const st = getAvail(bandForAvail, mem.user.id, availDate);
      if (st === "AVAILABLE") ins.push(displayName(mem.user));
      if (st === "UNAVAILABLE") outs.push(displayName(mem.user));
    });
    $("evLineup").innerHTML = (admin || ins.length || outs.length)
      ? `<div><strong>In:</strong> ${ins.join(", ") || "—"}</div><div><strong>Out:</strong> ${outs.join(", ") || "—"}</div>`
      : "";
  }
  $("evAvailIn").classList.toggle("on", mine === "AVAILABLE");
  $("evAvailOut").classList.toggle("on", mine === "UNAVAILABLE");
  $("evAvailIn").onclick = () => setDot(availDate, "AVAILABLE");
  $("evAvailOut").onclick = () => setDot(availDate, "UNAVAILABLE");
  $("eventModal").classList.add("open");
  loadEventAlerts(eventId && !asCopy ? eventId : null);
  loadEventNotes(eventId && !asCopy ? eventId : null);
}
async function saveEvent() {
  const payload = {
    bandId: $("evBand").value, type: $("evType").value, title: $("evTitle").value.trim(),
    date: parseMDY($("evDate").value) || ($("evDateISO") && $("evDateISO").value) || $("evDate").value,
    start: parse12to24($("evStart").value), end: parse12to24($("evEnd").value),
    venue: $("evVenue").value.trim(), notes: ""
  };
  try {
    if (editingEventId && !duplicating) await api("/api/events/" + editingEventId, { method: "PUT", body: payload });
    else await api("/api/events", { method: "POST", body: payload });
    $("eventModal").classList.remove("open");
    editingEventId = null; duplicating = false;
    await loadState();
    toast("Saved");
  } catch (err) { toast(err.message); }
}
async function setDot(iso, status) {
  const current = getAvail(state.currentBandId, state.currentUserId, iso);
  const next = status === "CLEAR" ? "" : (current === status ? "" : status);
  try {
    const ids = isMergedView() ? myBandIds() : [state.currentBandId];
    for (const bandId of ids.filter(Boolean)) {
      await api("/api/availability", { method: "POST", body: { bandId, date: iso, status: next } });
    }
    await loadState();
    if ($("eventModal")?.classList.contains("open")) {
      $("evAvailIn")?.classList.toggle("on", next === "AVAILABLE");
      $("evAvailOut")?.classList.toggle("on", next === "UNAVAILABLE");
    }
  } catch (err) { toast(err.message); }
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "deleteBandBtn") {
    const b = currentBand();
    if (!b?.id || b.id === "all") return;
    if (!confirm("Delete " + b.name + "? This removes its gigs, rehearsals, and member list for that band.")) return;
    try {
      await api("/api/bands/" + b.id, { method: "DELETE" });
      state.currentBandId = "all";
      await loadState();
      toast("Band deleted");
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === "editAbbrBtn") {
    const b = currentBand();
    const short = prompt("Calendar abbreviation for " + b.name + "?", b.short || bandShort(b.id) || "");
    if (short === null || !short.trim()) return;
    try { await api("/api/bands/" + b.id, { method: "PUT", body: { short: short.trim() } }); await loadState(); toast("Abbreviation saved"); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === "showMoreUpcoming") { upcomingShown += 10; renderUpcoming(); return; }
  const uf = e.target.closest("[data-upfilter]");
  if (uf) { upcomingFilter = uf.dataset.upfilter; upcomingShown = 10; renderUpcoming(); return; }
  const band = e.target.closest("[data-band]");
  if (band) { state.currentBandId = band.dataset.band; upcomingShown = 10; $("bandMenu")?.classList.remove("open"); renderAll(); return; }
  const dot = e.target.closest("[data-dot]");
  if (dot) { setDot(dot.dataset.date, dot.dataset.dot); return; }
  const act = e.target.closest("[data-edit],[data-dup],[data-del]");
  if (act) {
    if (act.dataset.edit) openEventModal(null, act.dataset.edit);
    else if (act.dataset.dup) openEventModal(null, act.dataset.dup, true);
    else if (act.dataset.del) {
      if (!confirm("Delete this event?")) return;
      try {
        await api("/api/events/" + act.dataset.del, { method: "DELETE" });
        $("eventModal").classList.remove("open");
        await loadState();
        toast("Deleted");
      } catch (err) { toast(err.message); }
    }
    return;
  }
  const calDay = e.target.closest("#days .day");
  if (calDay && !calDay.classList.contains("out")) {
    const rosterTap = e.target.closest("[data-roster]");
    if (rosterTap) { openRoster(rosterTap.dataset.date); return; }
    const chip = e.target.closest(".chip");
    if (chip && chip.dataset.eid) { openEventModal(null, chip.dataset.eid); return; }
    if (calDay.dataset.firstEvent) { openEventModal(null, calDay.dataset.firstEvent); return; }
    const iso = calDay.dataset.date;
    const cur = getAvail(state.currentBandId, state.currentUserId, iso);
    const next = cur === "" ? "AVAILABLE" : cur === "AVAILABLE" ? "UNAVAILABLE" : "";
    setDot(iso, next === "" ? "CLEAR" : next);
    return;
  }
  const listEv = e.target.closest("#upcoming [data-eid]");
  if (listEv) { openEventModal(null, listEv.dataset.eid); return; }
  if (e.target.dataset.editMember) {
    const u = state.users.find(x => x.id === e.target.dataset.editMember);
    if (!u) return;
    $("editMemberId").value = u.id;
    $("editMemberFirst").value = u.firstName || (u.name || "").split(" ")[0] || "";
    $("editMemberLast").value = u.lastName || (u.name || "").split(" ").slice(1).join(" ") || "";
    $("editMemberBday").value = u.birthday ? String(u.birthday).slice(0, 10) : "";
    $("editMemberEmail").value = u.email || "";
    const mem = state.memberships.find(m => m.userId === u.id && (isMergedView() || m.bandId === state.currentBandId));
    $("editMemberRole").value = mem?.role || "member";
    const adminBands = state.bands.filter(b => state.memberships.some(m => m.userId === state.currentUserId && m.bandId === b.id && m.role === "admin"));
    const theirs = new Set(state.memberships.filter(m => m.userId === u.id).map(m => m.bandId));
    $("editMemberBands").innerHTML = adminBands.map(b =>
      `<label style="display:block;margin:4px 0"><input type="checkbox" class="edit-band" value="${b.id}" ${theirs.has(b.id)?"checked":""}> ${b.name}</label>`
    ).join("");
    $("memberModal").classList.add("open");
  }
  if (e.target.dataset.delMember) {
    if (!confirm("Remove this member?")) return;
    const q = isMergedView() ? "" : ("?bandId=" + encodeURIComponent(state.currentBandId));
    try { await api("/api/members/" + e.target.dataset.delMember + q, { method: "DELETE" }); await loadState(); toast("Removed"); }
    catch (err) { toast(err.message); }
  }
});

$("loginBtn").onclick = async () => {
  try {
    const email = $("loginEmail").value.trim();
    const data = await api("/api/login", { method: "POST", body: { email, password: $("loginPass").value } });
    token = data.token; localStorage.setItem("mbg.token", token); localStorage.setItem("mbg.email", email); await loadState();
  } catch (err) { toast(err.message); }
};
$("signupBtn").onclick = async () => {
  try {
    const data = await api("/api/signup", { method: "POST", body: { name: $("loginName").value, email: $("loginEmail").value, password: $("loginPass").value } });
    token = data.token; localStorage.setItem("mbg.token", token); await loadState();
  } catch (err) { toast(err.message); }
};

async function openProfile() {
  const me = currentUser();
  $("profFirst").value = me.firstName || (me.name || "").split(" ")[0] || "";
  $("profLast").value = me.lastName || (me.name || "").split(" ").slice(1).join(" ") || "";
  $("profPhone").value = me.phone || "";
  $("profEmail").value = me.email || "";
  fillBdaySelects(me.birthday ? String(me.birthday).slice(0, 10) : "");
  $("profCurPass").value = "";
  $("profNewPass").value = "";
  $("profileModal").classList.add("open");
}
if ($("profileBtn")) $("profileBtn").onclick = openProfile;
if ($("closeProfileBtn")) $("closeProfileBtn").onclick = () => $("profileModal").classList.remove("open");
if ($("profileModal")) $("profileModal").addEventListener("click", e => { if (e.target.id === "profileModal") $("profileModal").classList.remove("open"); });
if ($("saveProfileBtn")) $("saveProfileBtn").onclick = async () => {
  try {
    await api("/api/me", { method: "PUT", body: {
      firstName: $("profFirst").value, lastName: $("profLast").value,
      phone: $("profPhone").value, email: $("profEmail").value, birthday: bdayFromSelects()
    }});
    localStorage.setItem("mbg.email", $("profEmail").value.trim());
    await loadState();
    toast("Profile saved");
  } catch (err) { toast(err.message); }
};
if ($("savePassBtn")) $("savePassBtn").onclick = async () => {
  try {
    await api("/api/me/password", { method: "PUT", body: { current: $("profCurPass").value, next: $("profNewPass").value } });
    $("profCurPass").value = ""; $("profNewPass").value = "";
    toast("Password changed");
  } catch (err) { toast(err.message); }
};
async function copyCal(kind) {
  try {
    const links = await api("/api/me/calendar");
    const url = kind === "mine" ? links.mine : links.all;
    await navigator.clipboard.writeText(url);
    toast("Link copied. Paste it in Google Calendar → From URL");
  } catch (err) { toast(err.message); }
}
if ($("copyCalAll")) $("copyCalAll").onclick = () => copyCal("all");
if ($("copyCalMine")) $("copyCalMine").onclick = () => copyCal("mine");

$("logoutBtn").onclick = () => { token = ""; localStorage.removeItem("mbg.token"); document.body.classList.remove("is-admin"); renderAuth(); };
function openRoster(iso) {
  $("rosterTitle").textContent = formatMDY(iso);
  const roster = bandMembers(state.currentBandId);
  const ins = [], outs = [], blank = [];
  roster.forEach(mem => {
    const st = getAvail(state.currentBandId, mem.user.id, iso);
    const n = displayName(mem.user);
    if (st === "AVAILABLE") ins.push(n);
    else if (st === "UNAVAILABLE") outs.push(n);
    else blank.push(n);
  });
  const block = (label, cls, arr) =>
    `<div class="event" style="cursor:default"><div class="meta"><strong class="${cls}">${label}</strong><div style="margin-top:4px">${arr.length ? arr.join("<br>") : "—"}</div></div></div>`;
  $("rosterList").innerHTML = block("In", "AVAILABLE", ins) + block("Out", "UNAVAILABLE", outs) + (blank.length ? block("Not marked", "", blank) : "");
  $("rosterModal").classList.add("open");
}
if ($("closeRosterBtn")) $("closeRosterBtn").onclick = () => $("rosterModal").classList.remove("open");
if ($("rosterModal")) $("rosterModal").addEventListener("click", e => { if (e.target.id === "rosterModal") $("rosterModal").classList.remove("open"); });
$("prevMonth").onclick = () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } renderCalendar(); };
$("nextMonth").onclick = () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } renderCalendar(); };
$("addEventBtn").onclick = () => openEventModal(toISODate(viewYear, viewMonth, new Date().getDate()));
if ($("evDateBtn") && $("evDateISO")) {
  $("evDateBtn").onclick = (e) => {
    e.preventDefault();
    try { $("evDateISO").showPicker(); } catch (err) { $("evDateISO").click(); }
  };
  $("evDateISO").addEventListener("change", () => {
    $("evDate").value = formatMDY($("evDateISO").value);
  });
  $("evDate").addEventListener("change", () => {
    const iso = parseMDY($("evDate").value);
    if (iso && $("evDateISO")) $("evDateISO").value = iso;
  });
}
$("cancelEvent").onclick = () => $("eventModal").classList.remove("open");
$("saveEvent").onclick = saveEvent;
if ($("evNoteAdd")) $("evNoteAdd").onclick = async () => {
  if (!notesEventId) { toast("Save the event first, then add notes."); return; }
  const message = ($("evNoteInput").value || "").trim();
  if (!message) return;
  try {
    await api("/api/events/" + notesEventId + "/notes", { method: "POST", body: { message } });
    $("evNoteInput").value = "";
    await loadEventNotes(notesEventId);
  } catch (err) { toast(err.message); }
};
document.addEventListener("click", async (e) => {
  if (e.target.dataset.noteEdit && notesEventId) {
    const cur = e.target.closest(".note-item")?.querySelector(".note-text")?.textContent || "";
    const next = prompt("Edit note", cur);
    if (next === null) return;
    try {
      await api("/api/events/" + notesEventId + "/notes/" + e.target.dataset.noteEdit, { method: "PUT", body: { message: next } });
      await loadEventNotes(notesEventId);
    } catch (err) { toast(err.message); }
  }
  if (e.target.dataset.noteDel && notesEventId) {
    if (!confirm("Delete this note?")) return;
    try {
      await api("/api/events/" + notesEventId + "/notes/" + e.target.dataset.noteDel, { method: "DELETE" });
      await loadEventNotes(notesEventId);
    } catch (err) { toast(err.message); }
  }
});

$("dupEventBtn").onclick = () => {
  if (!editingEventId) return;
  openEventModal(null, editingEventId, true);
};
$("deleteEventBtn").onclick = async () => {
  if (!editingEventId) return;
  if (!confirm("Delete this event?")) return;
  try {
    await api("/api/events/" + editingEventId, { method: "DELETE" });
    $("eventModal").classList.remove("open");
    editingEventId = null;
    await loadState();
    toast("Deleted");
  } catch (err) { toast(err.message); }
};
$("eventModal").addEventListener("click", e => { if (e.target.id === "eventModal") $("eventModal").classList.remove("open"); });
$("bandToggle").onclick = (e) => { e.stopPropagation(); $("bandMenu").classList.toggle("open"); };
document.addEventListener("click", (e) => {
  if ($("bandMenu") && !$("bandMenu").contains(e.target)) $("bandMenu").classList.remove("open");
});
$("addBandBtn").onclick = async () => {
  const name = prompt("Band name?");
  if (!name) return;
  const short = prompt("Abbreviation for the calendar (example: THoRR or Retro)?", name.slice(0, 8));
  if (short === null) return;
  try { await api("/api/bands", { method: "POST", body: { name, short } }); await loadState(); }
  catch (err) { toast(err.message); }
};
$("inviteBtn").onclick = async () => {
  try {
    const bandIds = [...document.querySelectorAll(".invite-band:checked")].map(el => el.value);
    const data = await api("/api/members", { method: "POST", body: {
      firstName: $("inviteFirst").value, lastName: $("inviteLast").value,
      birthday: $("inviteBday").value, email: $("inviteEmail").value, bandIds
    }});
    showInviteLink(location.origin + data.link);
    toast("Member added. Link copied.");
    await loadState();
  } catch (err) { toast(err.message); }
};
$("cancelMemberBtn").onclick = () => $("memberModal").classList.remove("open");
$("saveMemberBtn").onclick = async () => {
  try {
    const bandIds = [...document.querySelectorAll(".edit-band:checked")].map(el => el.value);
    await api("/api/members/" + $("editMemberId").value, { method: "PUT", body: {
      firstName: $("editMemberFirst").value, lastName: $("editMemberLast").value,
      birthday: $("editMemberBday").value, email: $("editMemberEmail").value,
      role: $("editMemberRole").value, bandIds
    }});
    $("memberModal").classList.remove("open");
    await loadState();
    toast("Member updated");
  } catch (err) { toast(err.message); }
};
$("resendLinkBtn").onclick = async () => {
  try {
    const bandIds = [...document.querySelectorAll(".edit-band:checked")].map(el => el.value);
    const data = await api("/api/members", { method: "POST", body: {
      firstName: $("editMemberFirst").value, lastName: $("editMemberLast").value,
      birthday: $("editMemberBday").value, email: $("editMemberEmail").value, bandIds
    }});
    showInviteLink(location.origin + data.link);
    toast("New setup link copied");
  } catch (err) { toast(err.message); }
};

(async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const setup = hash.get("setup");
  if (setup) {
    $("authHint").textContent = "Set a password and tap Sign in to join your bands.";
    $("loginBtn").textContent = "Set password & enter";
    $("signupBtn").style.display = "none";
    $("loginBtn").onclick = async () => {
      try {
        const data = await api("/api/setup", { method: "POST", body: { token: setup, password: $("loginPass").value } });
        token = data.token; localStorage.setItem("mbg.token", token); location.hash = ""; await loadState();
      } catch (err) { toast(err.message); }
    };
  }
  if (token && !setup) {
    try { await loadState(); if (!didDeepLink) { didDeepLink = true; openDeepLink(); } } catch { token = ""; localStorage.removeItem("mbg.token"); renderAuth(); }
  } else renderAuth();
})();
