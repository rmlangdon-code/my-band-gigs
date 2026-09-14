const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("mbg.token") || "";
let state = { currentUserId: "", users: [], bands: [], memberships: [], events: [], availability: {}, activity: [], currentBandId: "all" };
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let editingEventId = null;
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
  const wrap = $("toasts");
  if (!wrap) return alert(msg);
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
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
function firstName(user) { return (user?.name || "?").split(" ")[0]; }
function bandShort(bandId) { return state.bands.find(b => b.id === bandId)?.short || ""; }
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
function getAvail(bandId, userId, iso) {
  if (bandId === "all") {
    const marks = myBandIds().map(id => state.availability[`${id}:${userId}:${iso}`]);
    if (marks.includes("UNAVAILABLE")) return "UNAVAILABLE";
    return "AVAILABLE";
  }
  return state.availability[`${bandId}:${userId}:${iso}`] || "AVAILABLE";
}
function toISODate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function formatMDY(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
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
  return `${String(h).padStart(2, "0")}:${mi}`;
}

async function loadState() {
  const data = await api("/api/state");
  state = { ...state, ...data, currentBandId: state.currentBandId || "all" };
  if (state.currentBandId !== "all" && !state.bands.some(b => b.id === state.currentBandId)) state.currentBandId = "all";
  renderAll();
}

function renderAuth() {
  $("authScreen").style.display = token ? "none" : "grid";
  $("appScreen").style.display = token ? "block" : "none";
}

function renderBands() {
  const items = [{ id: "all", name: "All bands", sub: "Merged calendar" }, ...state.bands.map(b => ({
    id: b.id, name: b.name, sub: b.short
  }))];
  $("bands").innerHTML = items.map(b => `
    <button class="band-item ${state.currentBandId === b.id ? "active" : ""}" data-band="${b.id}">
      <strong>${b.name}</strong><span>${b.sub}</span>
    </button>`).join("");
}

function renderCalendar() {
  const y = viewYear, m = viewMonth;
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  $("monthLabel").textContent = first.toLocaleString("en-US", { month: "long", year: "numeric" });
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
  $("days").innerHTML = cells.map(({ date, out }) => {
    const iso = toISODate(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEvents = events.filter(e => e.date === iso);
    const roster = bandMembers(state.currentBandId);
    let availHtml = "";
    if (isAdmin()) {
      availHtml = `<div class="glance">${roster.map(mem => {
        const status = getAvail(state.currentBandId, mem.user.id, iso);
        return `<span class="avail-mark ${status}">${firstName(mem.user)} ${status === "UNAVAILABLE" ? "out" : "in"}</span>`;
      }).join("")}</div>`;
    } else {
      const avail = getAvail(state.currentBandId, state.currentUserId, iso);
      availHtml = `<div class="avail-mark ${avail}">${avail === "UNAVAILABLE" ? "Out" : "In"}</div>`;
    }
    return `<button class="day ${out ? "out" : ""} ${iso === todayISO ? "today" : ""}" data-date="${iso}">
      <div class="n">${date.getDate()}</div>
      ${dayEvents.slice(0, 2).map(e => `<span class="chip ${e.type}">${isMergedView() ? bandShort(e.bandId) + " · " : ""}${e.title}</span>`).join("")}
      ${availHtml}
    </button>`;
  }).join("");
}

function renderUpcoming() {
  const today = toISODate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const upcoming = eventsForBand(state.currentBandId).filter(e => e.date >= today).slice(0, 8);
  $("upcoming").innerHTML = upcoming.length ? upcoming.map(e => `
    <div class="event">
      <h3 class="${e.type}">${e.title}</h3>
      <div class="meta">${bandShort(e.bandId)} · ${e.type.toUpperCase()} · ${formatMDY(e.date)} · ${formatTime24to12(e.start)} – ${formatTime24to12(e.end)}</div>
      <div class="meta">${e.venue || "Venue TBD"}</div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn" data-edit="${e.id}">Edit</button>
        <button class="btn" data-dup="${e.id}">Duplicate</button>
        <button class="btn btn-danger" data-del="${e.id}">Delete</button>
      </div>
    </div>`).join("") : `<div class="hint">No upcoming events for this band.</div>`;
}

function renderMembers() {
  $("members").innerHTML = bandMembers(state.currentBandId).map(m =>
    `<div class="meta">${m.user.name} · ${m.role}${m.user.id === state.currentUserId ? " (you)" : ""}</div>`
  ).join("") || `<div class="meta">No members yet.</div>`;
  const adminBands = state.bands.filter(b =>
    state.memberships.some(m => m.userId === state.currentUserId && m.bandId === b.id && m.role === "admin")
  );
  if ($("inviteBands")) {
    $("inviteBands").innerHTML = adminBands.map(b =>
      `<label style="display:block;margin:4px 0"><input type="checkbox" class="invite-band" value="${b.id}" checked> ${b.name}</label>`
    ).join("") || "Create a band first.";
  }
}

function renderActivity() {
  const ids = isMergedView() ? myBandIds() : [state.currentBandId];
  const items = state.activity.filter(a => ids.includes(a.bandId)).slice(0, 12);
  $("activity").innerHTML = items.length
    ? items.map(a => `<div>${formatMDY(String(a.at).slice(0, 10))} · ${a.message}</div>`).join("")
    : `<div>No alerts yet.</div>`;
}

function renderAll() {
  renderAuth();
  if (!token) return;
  $("who").textContent = currentUser().name;
  $("bandName").textContent = currentBand().name;
  renderBands();
  renderCalendar();
  renderUpcoming();
  renderMembers();
  renderActivity();
}

function openEventModal(dateISO, eventId, asCopy) {
  try {
    const ids = myBandIds();
    if (!ids.length) { toast("Add or join a band first."); return; }
    editingEventId = asCopy ? null : (eventId || null);
    duplicating = !!asCopy;
    const ev = state.events.find(e => e.id === eventId);
    $("modalTitle").textContent = asCopy ? "Duplicate event — change what you need, then Save" : (ev ? "Edit event" : "Add gig or rehearsal");
    $("evBand").innerHTML = ids.map(id => {
      const b = state.bands.find(x => x.id === id);
      if (!b) return "";
      return `<option value="${b.id}">${b.name}</option>`;
    }).join("");
    $("evBand").value = ev?.bandId || (isMergedView() ? ids[0] : state.currentBandId) || ids[0];
    $("evTitle").value = ev?.title || "";
    $("evType").value = ev?.type || "gig";
    $("evDate").value = ev?.date || dateISO || toISODate(viewYear, viewMonth, 1);
    $("evStart").value = ev ? formatTime24to12(ev.start) : "7:00 PM";
    $("evEnd").value = ev ? formatTime24to12(ev.end) : "10:00 PM";
    $("evVenue").value = ev?.venue || "";
    $("evNotes").value = ev?.notes || "";
    const iso = ev?.date || dateISO;
    $("evAvail").value = getAvail($("evBand").value, state.currentUserId, iso);
    $("eventModal").classList.add("open");
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not open event form");
  }
}

async function saveEvent() {
  const payload = {
    bandId: $("evBand").value,
    type: $("evType").value,
    title: $("evTitle").value.trim(),
    date: $("evDate").value,
    start: parse12to24($("evStart").value),
    end: parse12to24($("evEnd").value),
    venue: $("evVenue").value.trim(),
    notes: $("evNotes").value.trim()
  };
  try {
    if (editingEventId && !duplicating) await api("/api/events/" + editingEventId, { method: "PUT", body: payload });
    else await api("/api/events", { method: "POST", body: payload });
    await api("/api/availability", { method: "POST", body: { bandId: payload.bandId, date: payload.date, status: $("evAvail").value } });
    $("eventModal").classList.remove("open");
    editingEventId = null;
    duplicating = false;
    await loadState();
    toast("Saved");
  } catch (err) { toast(err.message); }
}

document.addEventListener("click", async (e) => {
  const band = e.target.closest("[data-band]");
  if (band) { state.currentBandId = band.dataset.band; renderAll(); }
  const day = e.target.closest(".day");
  if (day && day.dataset.date) openEventModal(day.dataset.date);
  if (e.target.dataset.edit) openEventModal(null, e.target.dataset.edit);
  if (e.target.dataset.dup) openEventModal(null, e.target.dataset.dup, true);
  if (e.target.dataset.del) {
    if (!confirm("Delete this event?")) return;
    try { await api("/api/events/" + e.target.dataset.del, { method: "DELETE" }); await loadState(); }
    catch (err) { toast(err.message); }
  }
});

$("loginBtn").onclick = async () => {
  try {
    const data = await api("/api/login", { method: "POST", body: { email: $("loginEmail").value, password: $("loginPass").value } });
    token = data.token; localStorage.setItem("mbg.token", token); await loadState();
  } catch (err) { toast(err.message); }
};
$("signupBtn").onclick = async () => {
  try {
    const data = await api("/api/signup", { method: "POST", body: { name: $("loginName").value, email: $("loginEmail").value, password: $("loginPass").value } });
    token = data.token; localStorage.setItem("mbg.token", token); await loadState();
  } catch (err) { toast(err.message); }
};
$("logoutBtn").onclick = () => { token = ""; localStorage.removeItem("mbg.token"); renderAuth(); };
$("prevMonth").onclick = () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } renderCalendar(); };
$("nextMonth").onclick = () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } renderCalendar(); };
$("addEventBtn").onclick = () => openEventModal(toISODate(viewYear, viewMonth, new Date().getDate()));
$("cancelEvent").onclick = () => $("eventModal").classList.remove("open");
$("eventModal").addEventListener("click", (e) => {
  if (e.target.id === "eventModal") $("eventModal").classList.remove("open");
});
$("saveEvent").onclick = saveEvent;
$("addBandBtn").onclick = async () => {
  const name = prompt("Band name?");
  if (!name) return;
  try { await api("/api/bands", { method: "POST", body: { name } }); await loadState(); }
  catch (err) { toast(err.message); }
};
$("inviteBtn").onclick = async () => {
  try {
    const bandIds = [...document.querySelectorAll(".invite-band:checked")].map(el => el.value);
    const data = await api("/api/members", {
      method: "POST",
      body: { name: $("inviteName").value, email: $("inviteEmail").value, bandIds }
    });
    const url = location.origin + data.link;
    $("inviteOut").textContent = "Send this link: " + url;
    navigator.clipboard?.writeText(url);
    toast("Member added. Link copied.");
    await loadState();
  } catch (err) { toast(err.message); }
};

(async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const setup = hash.get("setup");
  const invite = hash.get("invite");
  if (setup) {
    $("authHint").textContent = "Set a password (6+ characters) and tap Sign in to finish joining your bands.";
    $("loginBtn").textContent = "Set password & enter";
    $("signupBtn").style.display = "none";
    const oldLogin = $("loginBtn").onclick;
    $("loginBtn").onclick = async () => {
      try {
        const data = await api("/api/setup", { method: "POST", body: { token: setup, password: $("loginPass").value } });
        token = data.token; localStorage.setItem("mbg.token", token);
        location.hash = "";
        await loadState();
      } catch (err) { toast(err.message); }
    };
  }
  if (token && !setup) {
    try { await loadState(); } catch { token = ""; localStorage.removeItem("mbg.token"); renderAuth(); }
  } else renderAuth();
  if (invite && !setup) $("authHint").textContent = "You have an invite. Create an account with the invited email.";
})();
