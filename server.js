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
  path.join(__dirname, "mybandgigs-app", "public"),
  path.join(process.cwd(), "mybandgigs-app", "public"),
  __dirname,
  process.cwd()
].find(dir => fs.existsSync(path.join(dir, "index.html")));

console.log("cwd=", process.cwd(), "dirname=", __dirname, "PUBLIC_DIR=", PUBLIC_DIR || "NOT FOUND");
try { console.log("root files=", fs.readdirSync(process.cwd()).join(", ")); } catch (e) {}
if (!PUBLIC_DIR) console.error("Missing index.html. Unzip first — do not upload the .zip file itself.");


const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const app = express();
app.use(express.json());
if (PUBLIC_DIR) app.use(express.static(PUBLIC_DIR));

function id() {
  return crypto.randomUUID();
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      band_id TEXT REFERENCES bands(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      token TEXT UNIQUE NOT NULL,
      invited_by TEXT REFERENCES users(id),
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "30d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Sign in again." });
  }
}

async function isAdminOf(userId, bandId) {
  const r = await pool.query(
    "SELECT role FROM memberships WHERE user_id=$1 AND band_id=$2",
    [userId, bandId]
  );
  return r.rows[0]?.role === "admin";
}

async function memberOf(userId, bandId) {
  const r = await pool.query(
    "SELECT 1 FROM memberships WHERE user_id=$1 AND band_id=$2",
    [userId, bandId]
  );
  return r.rowCount > 0;
}

app.post("/api/signup", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";
    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: "Name, email, and a password of 6+ characters required." });
    }
    const exists = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (exists.rowCount) return res.status(400).json({ error: "That email is already in use." });

    const userCount = (await pool.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n;
    const user = { id: id(), name, email, password_hash: await bcrypt.hash(password, 10) };
    await pool.query(
      "INSERT INTO users (id, name, email, password_hash) VALUES ($1,$2,$3,$4)",
      [user.id, user.name, user.email, user.password_hash]
    );

    if (userCount === 0) {
      const thorr = { id: id(), name: "The Heart of Rock & Roll", short: "THoRR" };
      const retro = { id: id(), name: "Retro Revolution", short: "Retro" };
      for (const b of [thorr, retro]) {
        await pool.query(
          "INSERT INTO bands (id, name, short, created_by) VALUES ($1,$2,$3,$4)",
          [b.id, b.name, b.short, user.id]
        );
        await pool.query(
          "INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,'admin')",
          [user.id, b.id]
        );
      }
    }

    res.json({ token: sign(user), user: { id: user.id, name, email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";
    const r = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(400).json({ error: "Wrong email or password." });
    }
    res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/state", auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const users = (await pool.query("SELECT id, name, email, first_name AS \"firstName\", last_name AS \"lastName\", birthday::text FROM users ORDER BY name")).rows;
    const memberships = (await pool.query(
      `SELECT m.* FROM memberships m WHERE m.user_id=$1
       OR m.band_id IN (SELECT band_id FROM memberships WHERE user_id=$1)`,
      [uid]
    )).rows;
    const bandIds = [...new Set(memberships.map(m => m.band_id))];
    const bands = bandIds.length
      ? (await pool.query("SELECT * FROM bands WHERE id = ANY($1)", [bandIds])).rows
      : [];
    const events = bandIds.length
      ? (await pool.query(
          "SELECT id, band_id AS \"bandId\", type, title, date::text, start_time AS start, end_time AS \"end\", venue, notes FROM events WHERE band_id = ANY($1) ORDER BY date, start_time",
          [bandIds]
        )).rows
      : [];
    const availRows = bandIds.length
      ? (await pool.query(
          "SELECT band_id, user_id, date::text, status FROM availability WHERE band_id = ANY($1)",
          [bandIds]
        )).rows
      : [];
    const availability = {};
    for (const a of availRows) availability[`${a.band_id}:${a.user_id}:${a.date}`] = a.status;
    const activity = bandIds.length
      ? (await pool.query(
          "SELECT id, band_id AS \"bandId\", message, at FROM activity WHERE band_id = ANY($1) ORDER BY at DESC LIMIT 40",
          [bandIds]
        )).rows
      : [];
    const myMemberships = memberships.filter(m => m.user_id === uid).map(m => ({
      userId: m.user_id, bandId: m.band_id, role: m.role
    }));
    const allMemberships = memberships.map(m => ({ userId: m.user_id, bandId: m.band_id, role: m.role }));
    res.json({
      currentUserId: uid,
      users,
      bands,
      memberships: allMemberships,
      myMemberships,
      events,
      availability,
      activity
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load calendar" });
  }
});

app.post("/api/bands", auth, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Band name required" });
    const short = (req.body.short || name).slice(0, 12);
    const band = { id: id(), name, short };
    await pool.query(
      "INSERT INTO bands (id, name, short, created_by) VALUES ($1,$2,$3,$4)",
      [band.id, band.name, band.short, req.user.id]
    );
    await pool.query(
      "INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,'admin')",
      [req.user.id, band.id]
    );
    res.json(band);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not add band" });
  }
});

app.post("/api/events", auth, async (req, res) => {
  try {
    const { bandId, type, title, date, start, end, venue, notes } = req.body;
    if (!(await memberOf(req.user.id, bandId))) return res.status(403).json({ error: "Not in that band" });
    if (!(await isAdminOf(req.user.id, bandId))) return res.status(403).json({ error: "Only admins can add events" });
    const ev = {
      id: id(),
      bandId,
      type: type === "rehearsal" ? "rehearsal" : "gig",
      title: (title || (type === "rehearsal" ? "Rehearsal" : "Gig")).trim(),
      date,
      start,
      end,
      venue: venue || "",
      notes: notes || ""
    };
    await pool.query(
      `INSERT INTO events (id, band_id, type, title, date, start_time, end_time, venue, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ev.id, ev.bandId, ev.type, ev.title, ev.date, ev.start, ev.end, ev.venue, ev.notes]
    );
    await pool.query(
      "INSERT INTO activity (id, band_id, message) VALUES ($1,$2,$3)",
      [id(), bandId, `${req.user.name} added ${ev.type}: ${ev.title} (${ev.date})`]
    );
    res.json(ev);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save event" });
  }
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
      [type || old.type, title || old.title, date || old.date, start || old.start_time, end || old.end_time, venue ?? old.venue, notes ?? old.notes, bandId || old.band_id, req.params.id]
    );
    await pool.query(
      "INSERT INTO activity (id, band_id, message) VALUES ($1,$2,$3)",
      [id(), bandId || old.band_id, `${req.user.name} changed ${title || old.title}`]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update event" });
  }
});

app.delete("/api/events/:id", auth, async (req, res) => {
  try {
    const found = await pool.query("SELECT * FROM events WHERE id=$1", [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: "Event not found" });
    const old = found.rows[0];
    if (!(await isAdminOf(req.user.id, old.band_id))) return res.status(403).json({ error: "Only admins can delete events" });
    await pool.query("DELETE FROM events WHERE id=$1", [req.params.id]);
    await pool.query(
      "INSERT INTO activity (id, band_id, message) VALUES ($1,$2,$3)",
      [id(), old.band_id, `${req.user.name} deleted ${old.title}`]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete event" });
  }
});

app.post("/api/availability", auth, async (req, res) => {
  try {
    const { bandId, date, status } = req.body;
    if (!(await memberOf(req.user.id, bandId))) return res.status(403).json({ error: "Not in that band" });
    if (!status || status === "BLANK") {
      await pool.query(
        "DELETE FROM availability WHERE band_id=$1 AND user_id=$2 AND date=$3",
        [bandId, req.user.id, date]
      );
    } else {
      await pool.query(
        `INSERT INTO availability (band_id, user_id, date, status) VALUES ($1,$2,$3,$4)
         ON CONFLICT (band_id, user_id, date) DO UPDATE SET status=$4`,
        [bandId, req.user.id, date, status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE"]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save availability" });
  }
});

app.post("/api/members", auth, async (req, res) => {
  try {
    const firstName = (req.body.firstName || "").trim();
    const lastName = (req.body.lastName || "").trim();
    const name = (req.body.name || `${firstName} ${lastName}`).trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const birthday = req.body.birthday || null;
    let bandIds = Array.isArray(req.body.bandIds) ? req.body.bandIds.filter(Boolean) : [];
    if (!bandIds.length && req.body.bandId) bandIds = [req.body.bandId];
    if (!name || !email) return res.status(400).json({ error: "First name, last name, and email required" });
    if (!bandIds.length) return res.status(400).json({ error: "Pick at least one band" });
    for (const bid of bandIds) {
      if (!(await isAdminOf(req.user.id, bid))) {
        return res.status(403).json({ error: "You can only add members to bands you admin" });
      }
    }
    let user = (await pool.query("SELECT * FROM users WHERE email=$1", [email])).rows[0];
    const setupToken = crypto.randomBytes(16).toString("hex");
    if (!user) {
      user = {
        id: id(),
        name,
        email,
        password_hash: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10)
      };
      await pool.query(
        "INSERT INTO users (id, name, email, password_hash, setup_token, first_name, last_name, birthday) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [user.id, user.name, user.email, user.password_hash, setupToken, firstName || name.split(" ")[0], lastName || name.split(" ").slice(1).join(" "), birthday]
      );
    } else {
      await pool.query(
        "UPDATE users SET setup_token=$1, name=COALESCE(NULLIF($2,''), name), first_name=COALESCE(NULLIF($3,''), first_name), last_name=COALESCE(NULLIF($4,''), last_name), birthday=COALESCE($5::date, birthday) WHERE id=$6",
        [setupToken, name, firstName, lastName, birthday, user.id]
      );
    }
    for (const bid of bandIds) {
      await pool.query(
        `INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,'member')
         ON CONFLICT (user_id, band_id) DO NOTHING`,
        [user.id, bid]
      );
    }
    res.json({
      email,
      name,
      link: `/#setup=${setupToken}`,
      bands: bandIds
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not add member" });
  }
});

app.put("/api/members/:id", auth, async (req, res) => {
  try {
    const userId = req.params.id;
    const firstName = (req.body.firstName || "").trim();
    const lastName = (req.body.lastName || "").trim();
    const name = (req.body.name || `${firstName} ${lastName}`).trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const birthday = req.body.birthday || null;
    const role = req.body.role === "admin" ? "admin" : "member";
    let bandIds = Array.isArray(req.body.bandIds) ? req.body.bandIds.filter(Boolean) : null;
    const target = (await pool.query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
    if (!target) return res.status(404).json({ error: "Member not found" });
    const currentBands = (await pool.query("SELECT band_id FROM memberships WHERE user_id=$1", [userId])).rows.map(r => r.band_id);
    const checkIds = bandIds || currentBands;
    for (const bid of checkIds) {
      if (!(await isAdminOf(req.user.id, bid))) return res.status(403).json({ error: "Admin only" });
    }
    if (name) await pool.query(
      "UPDATE users SET name=$1, first_name=$2, last_name=$3, birthday=COALESCE($4::date, birthday) WHERE id=$5",
      [name, firstName || target.first_name, lastName || target.last_name, birthday, userId]
    );
    if (email && email !== target.email) {
      const taken = await pool.query("SELECT id FROM users WHERE email=$1 AND id<>$2", [email, userId]);
      if (taken.rowCount) return res.status(400).json({ error: "That email is already in use." });
      await pool.query("UPDATE users SET email=$1 WHERE id=$2", [email, userId]);
    }
    if (bandIds) {
      for (const bid of currentBands) {
        if (!bandIds.includes(bid) && (await isAdminOf(req.user.id, bid))) {
          await pool.query("DELETE FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, bid]);
        }
      }
      for (const bid of bandIds) {
        if (!(await isAdminOf(req.user.id, bid))) continue;
        await pool.query(
          `INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, band_id) DO UPDATE SET role=$3`,
          [userId, bid, role]
        );
      }
    } else if (req.body.bandId) {
      if (!(await isAdminOf(req.user.id, req.body.bandId))) return res.status(403).json({ error: "Admin only" });
      await pool.query("UPDATE memberships SET role=$1 WHERE user_id=$2 AND band_id=$3", [role, userId, req.body.bandId]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update member" });
  }
});

app.delete("/api/members/:id", auth, async (req, res) => {
  try {
    const userId = req.params.id;
    if (userId === req.user.id) return res.status(400).json({ error: "You can’t remove yourself." });
    const bandId = req.query.bandId || req.body?.bandId;
    if (bandId) {
      if (!(await isAdminOf(req.user.id, bandId))) return res.status(403).json({ error: "Admin only" });
      await pool.query("DELETE FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, bandId]);
      await pool.query("DELETE FROM availability WHERE user_id=$1 AND band_id=$2", [userId, bandId]);
    } else {
      const bands = (await pool.query("SELECT band_id FROM memberships WHERE user_id=$1", [userId])).rows;
      for (const row of bands) {
        if (await isAdminOf(req.user.id, row.band_id)) {
          await pool.query("DELETE FROM memberships WHERE user_id=$1 AND band_id=$2", [userId, row.band_id]);
          await pool.query("DELETE FROM availability WHERE user_id=$1 AND band_id=$2", [userId, row.band_id]);
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove member" });
  }
});

app.post("/api/setup", async (req, res) => {
  try {
    const token = req.body.token;
    const password = req.body.password || "";
    if (!token || password.length < 6) return res.status(400).json({ error: "Link and a password of 6+ characters required." });
    const user = (await pool.query("SELECT * FROM users WHERE setup_token=$1", [token])).rows[0];
    if (!user) return res.status(400).json({ error: "This setup link is invalid or already used." });
    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password_hash=$1, setup_token=NULL WHERE id=$2", [hash, user.id]);
    res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not finish setup" });
  }
});

app.post("/api/invites", auth, async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const bandId = req.body.bandId;
    const role = req.body.role === "admin" ? "admin" : "member";
    if (!email || !bandId) return res.status(400).json({ error: "Email and band required" });
    if (!(await isAdminOf(req.user.id, bandId))) return res.status(403).json({ error: "Only admins can invite" });
    const token = crypto.randomBytes(16).toString("hex");
    await pool.query(
      "INSERT INTO invites (id, email, band_id, role, token, invited_by) VALUES ($1,$2,$3,$4,$5,$6)",
      [id(), email, bandId, role, token, req.user.id]
    );
    const link = `/#invite=${token}`;
    res.json({ token, link, email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create invite" });
  }
});

app.post("/api/invites/accept", async (req, res) => {
  try {
    const token = req.body.token;
    const name = (req.body.name || "").trim();
    const password = req.body.password || "";
    const inv = (await pool.query("SELECT * FROM invites WHERE token=$1 AND used=FALSE", [token])).rows[0];
    if (!inv) return res.status(400).json({ error: "Invite is invalid or already used." });
    if (!name || password.length < 6) return res.status(400).json({ error: "Name and 6+ character password required." });

    let user = (await pool.query("SELECT * FROM users WHERE email=$1", [inv.email])).rows[0];
    if (!user) {
      user = { id: id(), name, email: inv.email, password_hash: await bcrypt.hash(password, 10) };
      await pool.query(
        "INSERT INTO users (id, name, email, password_hash) VALUES ($1,$2,$3,$4)",
        [user.id, user.name, user.email, user.password_hash]
      );
    }
    await pool.query(
      `INSERT INTO memberships (user_id, band_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, band_id) DO UPDATE SET role=EXCLUDED.role`,
      [user.id, inv.band_id, inv.role]
    );
    await pool.query("UPDATE invites SET used=TRUE WHERE id=$1", [inv.id]);
    res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not accept invite" });
  }
});

app.get("*", (req, res) => {
  if (!PUBLIC_DIR) return res.status(500).send("Missing public/index.html — upload the public folder next to server.js.");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log("My Band Gigs listening on " + PORT));
  })
  .catch((err) => {
    console.error("DB init failed", err);
    process.exit(1);
  });
