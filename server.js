const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PUBLIC_DIR = [
  path.join(__dirname, "public"),
  path.join(process.cwd(), "public"),
  __dirname,
  process.cwd()
].find(dir => fs.existsSync(path.join(dir, "index.html")));

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const app = express();
app.use(express.json());
if (PUBLIC_DIR) app.use(express.static(PUBLIC_DIR));

const id = () => crypto.randomUUID();

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      birthday DATE,
      setup_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short TEXT NOT NULL,
      created_by TEXT REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      band_id TEXT REFERENCES bands(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (user_id, band_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      band_id TEXT REFERENCES bands(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      date DATE NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      venue TEXT DEFAULT '',
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS availability (
      band_id TEXT REFERENCES bands(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (band_id, user_id, date)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      band_id TEXT REFERENCES bands(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday DATE;
  `);
}

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "30d" });
}
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in required" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Session expired" }); }
}
async function isAdminOf(userId, bandId) {
  const r = await pool.query("SELECT role FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, bandId]);
  return r.rows[0]?.role === "admin";
}
async function memberOf(userId, bandId) {
  const r = await pool.query("SELECT 1 FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, bandId]);
  return r.rowCount > 0;
}
async function adminOfAny(userId) {
  const r = await pool.query("SELECT 1 FROM memberships WHERE user_id=$1 AND role='admin' LIMIT 1", [userId]);
  return r.rowCount > 0;
}

app.post("/api/signup", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";
    if (!name || !email || password.length < 6) return res.status(400).json({ error: "Name, email, and 6+ character password required." });
    if ((await pool.query("SELECT id FROM users WHERE email=$1", [email])).rowCount)
      return res.status(400).json({ error: "That email is already in use." });
    const userCount = (await pool.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n;
    const user = { id: id(), name, email, password_hash: await bcrypt.hash(password, 10) };
    const parts = name.split(" ");
    await pool.query(
      "INSERT INTO users (id, name, email, password_hash, first_name, last_name) VALUES ($1,$2,$3,$4,$5,$6)",
      [user.id, name, email, user.password_hash, parts[0], parts.slice(1).join(" ")]
    );
    if (userCount === 0) {
      const bands = [
        { id: id(), name: "The Heart of Rock & Roll", short: "THoRR" },
        { id: id(), name: "Retro Revolution", short: "Retro" }
      ];
      for (const b of bands) {
        await pool.query("INSERT INTO bands (id, name, short, created_by) VALUES ($1,$2,$3,$4)", [b.id, b.name, b.short, user.id]);
        await pool.query("INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,'admin')", [user.id, b.id]);
      }
    }
    res.json({ token: sign(user), user: { id: user.id, name, email } });
  } catch (err) { console.error(err); res.status(500).json({ error: "Signup failed" }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const r = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password || "", user.password_hash)))
      return res.status(400).json({ error: "Wrong email or password." });
    res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) { console.error(err); res.status(500).json({ error: "Login failed" }); }
});

app.get("/api/state", auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const users = (await pool.query(
      `SELECT id, name, email, first_name AS "firstName", last_name AS "lastName", birthday::text FROM users ORDER BY name`
    )).rows;
    const memberships = (await pool.query(
      `SELECT user_id AS "userId", band_id AS "bandId", role FROM memberships
       WHERE band_id IN (SELECT band_id FROM memberships WHERE user_id=$1)`,
      [uid]
    )).rows;
    const bandIds = [...new Set(memberships.map(m => m.bandId))];
    const bands = bandIds.length ? (await pool.query("SELECT * FROM bands WHERE id = ANY($1)", [bandIds])).rows : [];
    const events = bandIds.length ? (await pool.query(
      `SELECT id, band_id AS "bandId", type, title, date::text, start_time AS start, end_time AS "end", venue, notes
       FROM events WHERE band_id = ANY($1) ORDER BY date, start_time`, [bandIds]
    )).rows : [];
    const availRows = bandIds.length ? (await pool.query(
      "SELECT band_id, user_id, date::text, status FROM availability WHERE band_id = ANY($1)", [bandIds]
    )).rows : [];
    const availability = {};
    for (const a of availRows) availability[`${a.band_id}:${a.user_id}:${String(a.date).slice(0,10)}`] = a.status;
    const activity = bandIds.length ? (await pool.query(
      `SELECT id, band_id AS "bandId", message, at FROM activity WHERE band_id = ANY($1) ORDER BY at DESC LIMIT 40`, [bandIds]
    )).rows : [];
    const isAdmin = memberships.some(m => m.userId === uid && m.role === "admin");
    res.json({ currentUserId: uid, isAdmin, users, bands, memberships, events, availability, activity });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not load calendar" }); }
});

app.post("/api/bands", auth, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Band name required" });
    const short = (req.body.short || name).trim().slice(0, 16);
    const band = { id: id(), name, short };
    await pool.query("INSERT INTO bands (id, name, short, created_by) VALUES ($1,$2,$3,$4)", [band.id, band.name, band.short, req.user.id]);
    await pool.query("INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,'admin')", [req.user.id, band.id]);
    res.json(band);
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not add band" }); }
});

app.put("/api/bands/:id", auth, async (req, res) => {
  try {
    if (!(await isAdminOf(req.user.id, req.params.id))) return res.status(403).json({ error: "Admin only" });
    const name = (req.body.name || "").trim();
    const short = (req.body.short || "").trim().slice(0, 16);
    if (name) await pool.query("UPDATE bands SET name=$1 WHERE id=$2", [name, req.params.id]);
    if (short) await pool.query("UPDATE bands SET short=$1 WHERE id=$2", [short, req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not update band" }); }
});

app.post("/api/events", auth, async (req, res) => {
  try {
    const { bandId, type, title, date, start, end, venue, notes } = req.body;
    if (!(await isAdminOf(req.user.id, bandId))) return res.status(403).json({ error: "Only admins can add gigs and rehearsals" });
    const ev = {
      id: id(), bandId, type: type === "rehearsal" ? "rehearsal" : "gig",
      title: (title || (type === "rehearsal" ? "Rehearsal" : "Gig")).trim(),
      date, start, end, venue: venue || "", notes: notes || ""
    };
    await pool.query(
      `INSERT INTO events (id, band_id, type, title, date, start_time, end_time, venue, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ev.id, ev.bandId, ev.type, ev.title, ev.date, ev.start, ev.end, ev.venue, ev.notes]
    );
    await pool.query("INSERT INTO activity (id, band_id, message) VALUES ($1,$2,$3)",
      [id(), bandId, `${req.user.name} added ${ev.type}: ${ev.title} (${ev.date})`]);
    res.json(ev);
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not save event" }); }
});

app.put("/api/events/:id", auth, async (req, res) => {
  try {
    const found = await pool.query("SELECT * FROM events WHERE id=$1", [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: "Event not found" });
    const old = found.rows[0];
    if (!(await isAdminOf(req.user.id, old.band_id))) return res.status(403).json({ error: "Only admins can edit events" });
    const { type, title, date, start, end, venue, notes, bandId } = req.body;
    await pool.query(
      `UPDATE events SET type=$1, title=$2, date=$3, start_time=$4, end_time=$5, venue=$6, notes=$7, band_id=$8 WHERE id=$9`,
      [type || old.type, title || old.title, date || old.date, start || old.start_time, end || old.end_time,
       venue ?? old.venue, notes ?? old.notes, bandId || old.band_id, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not update event" }); }
});

app.delete("/api/events/:id", auth, async (req, res) => {
  try {
    const found = await pool.query("SELECT * FROM events WHERE id=$1", [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: "Event not found" });
    const old = found.rows[0];
    if (!(await isAdminOf(req.user.id, old.band_id))) return res.status(403).json({ error: "Only admins can delete events" });
    await pool.query("DELETE FROM events WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not delete event" }); }
});

app.post("/api/availability", auth, async (req, res) => {
  try {
    const { bandId, date, status } = req.body;
    if (!(await memberOf(req.user.id, bandId))) return res.status(403).json({ error: "Not in that band" });
    if (!status) {
      await pool.query("DELETE FROM availability WHERE band_id=$1 AND user_id=$2 AND date=$3", [bandId, req.user.id, date]);
    } else {
      const st = status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE";
      await pool.query(
        `INSERT INTO availability (band_id, user_id, date, status) VALUES ($1,$2,$3,$4)
         ON CONFLICT (band_id, user_id, date) DO UPDATE SET status=$4`,
        [bandId, req.user.id, date, st]
      );
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not save availability" }); }
});

app.post("/api/members", auth, async (req, res) => {
  try {
    if (!(await adminOfAny(req.user.id))) return res.status(403).json({ error: "Admin only" });
    const firstName = (req.body.firstName || "").trim();
    const lastName = (req.body.lastName || "").trim();
    const name = `${firstName} ${lastName}`.trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const birthday = req.body.birthday || null;
    let bandIds = Array.isArray(req.body.bandIds) ? req.body.bandIds.filter(Boolean) : [];
    if (!name || !email) return res.status(400).json({ error: "First name, last name, and email required" });
    if (!bandIds.length) return res.status(400).json({ error: "Pick at least one band" });
    for (const bid of bandIds) if (!(await isAdminOf(req.user.id, bid))) return res.status(403).json({ error: "Admin only" });
    const setupToken = crypto.randomBytes(4).toString("hex");
    let user = (await pool.query("SELECT * FROM users WHERE email=$1", [email])).rows[0];
    if (!user) {
      user = { id: id(), name, email };
      await pool.query(
        "INSERT INTO users (id, name, email, password_hash, setup_token, first_name, last_name, birthday) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [user.id, name, email, await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10), setupToken, firstName, lastName, birthday]
      );
    } else {
      await pool.query(
        "UPDATE users SET setup_token=$1, name=$2, first_name=$3, last_name=$4, birthday=COALESCE($5::date, birthday) WHERE id=$6",
        [setupToken, name, firstName, lastName, birthday, user.id]
      );
    }
    for (const bid of bandIds) {
      await pool.query(
        `INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,'member') ON CONFLICT (user_id, band_id) DO NOTHING`,
        [user.id, bid]
      );
    }
    res.json({ email, name, link: `/#setup=${setupToken}`, bands: bandIds });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not add member" }); }
});

app.put("/api/members/:id", auth, async (req, res) => {
  try {
    if (!(await adminOfAny(req.user.id))) return res.status(403).json({ error: "Admin only" });
    const userId = req.params.id;
    const firstName = (req.body.firstName || "").trim();
    const lastName = (req.body.lastName || "").trim();
    const name = `${firstName} ${lastName}`.trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const birthday = req.body.birthday || null;
    const role = req.body.role === "admin" ? "admin" : "member";
    const bandIds = Array.isArray(req.body.bandIds) ? req.body.bandIds.filter(Boolean) : [];
    const target = (await pool.query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
    if (!target) return res.status(404).json({ error: "Member not found" });
    if (name) await pool.query(
      "UPDATE users SET name=$1, first_name=$2, last_name=$3, birthday=COALESCE($4::date, birthday) WHERE id=$5",
      [name, firstName, lastName, birthday, userId]
    );
    if (email && email !== target.email) {
      if ((await pool.query("SELECT id FROM users WHERE email=$1 AND id<>$2", [email, userId])).rowCount)
        return res.status(400).json({ error: "That email is already in use." });
      await pool.query("UPDATE users SET email=$1 WHERE id=$2", [email, userId]);
    }
    const current = (await pool.query("SELECT band_id FROM memberships WHERE user_id=$1", [userId])).rows.map(r => r.band_id);
    for (const bid of current) {
      if (!bandIds.includes(bid) && (await isAdminOf(req.user.id, bid)))
        await pool.query("DELETE FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, bid]);
    }
    for (const bid of bandIds) {
      if (!(await isAdminOf(req.user.id, bid))) continue;
      await pool.query(
        `INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, band_id) DO UPDATE SET role=$3`,
        [userId, bid, role]
      );
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not update member" }); }
});

app.delete("/api/members/:id", auth, async (req, res) => {
  try {
    const userId = req.params.id;
    if (userId === req.user.id) return res.status(400).json({ error: "You can’t remove yourself." });
    const bandId = req.query.bandId;
    if (bandId) {
      if (!(await isAdminOf(req.user.id, bandId))) return res.status(403).json({ error: "Admin only" });
      await pool.query("DELETE FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, bandId]);
    } else {
      const bands = (await pool.query("SELECT band_id FROM memberships WHERE user_id=$1", [userId])).rows;
      for (const row of bands) {
        if (await isAdminOf(req.user.id, row.band_id))
          await pool.query("DELETE FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, row.band_id]);
      }
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not remove member" }); }
});

app.post("/api/setup", async (req, res) => {
  try {
    const token = req.body.token;
    const password = req.body.password || "";
    if (!token || password.length < 6) return res.status(400).json({ error: "Link and a 6+ character password required." });
    const user = (await pool.query("SELECT * FROM users WHERE setup_token=$1", [token])).rows[0];
    if (!user) return res.status(400).json({ error: "This setup link is invalid or already used." });
    await pool.query("UPDATE users SET password_hash=$1, setup_token=NULL WHERE id=$2", [await bcrypt.hash(password, 10), user.id]);
    res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not finish setup" }); }
});

app.get("*", (req, res) => {
  if (!PUBLIC_DIR) return res.status(500).send("Missing public/index.html");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

initDb()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log("My Band Gigs on " + PORT)))
  .catch(err => { console.error(err); process.exit(1); });
