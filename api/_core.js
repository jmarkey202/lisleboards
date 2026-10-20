// Lisle Boards: request handling shared by the Vercel functions and the local test harness.
// Pure logic over a small key-value interface (get, set, del, hget, hset, hgetall, hdel, incr),
// which matches the @upstash/redis client. Files starting with "_" are not exposed as routes.

export const LIMITS = { title: 120, description: 1000, subject: 200, body: 5000, link: 2000, alt: 200, comment: 2000, name: 60, sectionTitle: 80, sections: 30, image: 1000000 };
const BOARD_ID = /^x[a-z0-9]{4,30}$/;
const POST_ID = /^x[a-z0-9]{4,30}$/;
const USER_ID = /^u[a-z0-9]{6,24}$/;
const IMG_ID = /^i[a-z0-9]{6,24}$/;
const FORMATS = ["wall", "columns", "grid", "stream", "timeline", "table"];
const REACTIONS = ["none", "like", "vote", "star", "grade"];
const COLORS = ["white", "mist", "sky", "slate", "navy"];
const GAP = 65536; // spacing between neighboring sortIndex values; matches the page

const j = (status, body) => ({ status, body });
const err = (status, message) => j(status, { error: message });
function parse(v) { if (v == null) return null; if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return v; } } return v; }
const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);
const bool = (v, d) => (typeof v === "boolean" ? v : d);
const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
const rid = (p) => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

async function values(kv, key) { const h = await kv.hgetall(key); return h ? Object.values(h).map(parse).filter(x => x && typeof x === "object") : []; }
async function bump(kv, key) { return kv.incr("ver:" + key); }
async function version(kv, key) { const v = await kv.get("ver:" + key); return String(v == null ? 0 : v); }
async function usersMap(kv) { const h = (await kv.hgetall("users")) || {}; const out = {}; for (const [k, v] of Object.entries(h)) { const u = parse(v); if (u && typeof u === "object") out[k] = { name: str(u.name, LIMITS.name) }; } return out; }

function cleanBoard(d, existing) {
  const b = existing ? { ...existing } : {};
  if ("title" in d) b.title = str(d.title, LIMITS.title).trim();
  if ("description" in d) b.description = str(d.description, LIMITS.description).trim();
  if ("format" in d) b.format = FORMATS.includes(d.format) ? d.format : "wall";
  if ("useSections" in d) b.useSections = bool(d.useSections, false);
  if ("sections" in d) b.sections = (Array.isArray(d.sections) ? d.sections : []).slice(0, LIMITS.sections).map((s, i) => ({ id: str(s && s.id, 40) || rid("s"), title: str(s && s.title, LIMITS.sectionTitle).trim() || "Untitled section", sortIndex: num(s && s.sortIndex, (i + 1) * GAP) }));
  if ("frozen" in d) b.frozen = bool(d.frozen, false);
  for (const k of ["requireSubject", "requireBody", "showAuthor", "showTime", "comments", "requireApproval"]) if (k in d) b[k] = bool(d[k], b[k] !== undefined ? b[k] : k === "showAuthor" || k === "showTime" || k === "comments");
  if ("newPostPos" in d) b.newPostPos = d.newPostPos === "bottom" ? "bottom" : "top";
  if ("reactions" in d) b.reactions = REACTIONS.includes(d.reactions) ? d.reactions : "none";
  if (b.format === "columns") b.useSections = true; if (b.format === "wall") b.useSections = false;
  if (b.useSections && !(b.sections || []).length) b.sections = [{ id: rid("s"), title: "Section 1", sortIndex: GAP }];
  return b;
}
function cleanPostFields(d, existing, board) {
  const p = existing ? { ...existing } : {};
  if ("subject" in d) p.subject = str(d.subject, LIMITS.subject).trim();
  if ("body" in d) p.body = str(d.body, LIMITS.body).trim();
  if ("link" in d) { const l = str(d.link, LIMITS.link).trim(); p.link = /^https?:\/\//i.test(l) ? l : ""; }
  if ("imageId" in d) p.imageId = typeof d.imageId === "string" && IMG_ID.test(d.imageId) ? d.imageId : null;
  if ("imageAlt" in d) p.imageAlt = str(d.imageAlt, LIMITS.alt).trim();
  if ("color" in d) p.color = COLORS.includes(d.color) ? d.color : "white";
  if ("sectionId" in d) { const sid = typeof d.sectionId === "string" ? d.sectionId : null; p.sectionId = sid && (board.sections || []).some(s => s.id === sid) ? sid : null; }
  if ("order" in d) p.order = num(d.order, 0);
  if ("sortIndex" in d) p.sortIndex = num(d.sortIndex, 0);
  return p;
}
function cleanComments(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 500).map(c => ({ id: str(c && c.id, 40) || rid("c"), authorId: str(c && c.authorId, 40), text: str(c && c.text, LIMITS.comment).trim(), createdAt: num(c && c.createdAt, Date.now()) })).filter(c => c.text);
}

export async function handle(req, kv, env) {
  try {
    const headers = req.headers || {};
    const access = env.ACCESS_CODE;
    if (!access) return err(500, "ACCESS_CODE is not set in the Vercel project's environment variables.");
    if ((headers["x-access"] || "") !== access) return err(401, "That access code is not right.");
    const admin = !!env.ADMIN_CODE && (headers["x-admin"] || "") === env.ADMIN_CODE;
    const uid = (headers["x-user"] || "").trim();
    if (!USER_ID.test(uid)) return err(400, "Missing user id. Reload the page and sign in again.");
    const now = Date.now();

    if (req.method === "GET") {
      const path = String((req.query && req.query.path) || "");
      const since = String((req.query && req.query.v) || "");
      if (path === "boards") {
        const v = await version(kv, "boards"); if (since && since === v) return j(200, { unchanged: true, v });
        const boards = (await values(kv, "boards")).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return j(200, { v, boards, users: await usersMap(kv) });
      }
      const m = /^boards\/(x[a-z0-9]+)$/.exec(path);
      if (m) {
        const bid = m[1]; if (!BOARD_ID.test(bid)) return err(400, "Bad board id.");
        const v = await version(kv, bid); if (since && since === v) return j(200, { unchanged: true, v });
        const board = parse(await kv.hget("boards", bid));
        if (!board || typeof board !== "object") return j(200, { v, board: null, posts: [], users: {} });
        const posts = await values(kv, "posts:" + bid);
        return j(200, { v, board, posts, users: await usersMap(kv) });
      }
      return err(400, "Unknown path.");
    }
    if (req.method !== "POST") return err(405, "Method not allowed.");
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const op = String(b.op || "");

    if (op === "hello") {
      const name = str(b.name, LIMITS.name).trim(); if (!name) return err(400, "Enter your name.");
      await kv.hset("users", { [uid]: JSON.stringify({ name, updatedAt: now }) });
      return j(200, { ok: true, admin, uid });
    }
    if (op === "image") {
      const data = typeof b.data === "string" ? b.data : "";
      if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return err(400, "Unsupported image. Use PNG, JPEG, GIF, or WebP.");
      if (data.length > LIMITS.image) return err(413, "That image is too large after compression. Try a smaller one.");
      const id = rid("i"); await kv.set("img:" + id, data); return j(200, { id });
    }
    if (op === "deleteImage") {
      const id = String(b.id || ""); if (!IMG_ID.test(id)) return err(400, "Bad image id.");
      await kv.del("img:" + id); return j(200, { ok: true });
    }

    const path = String(b.path || ""); const data = b.data && typeof b.data === "object" ? b.data : {};
    const bm = /^boards\/(x[a-z0-9]+)$/.exec(path); const pm = /^boards\/(x[a-z0-9]+)\/posts\/(x[a-z0-9]+)$/.exec(path);

    if (bm) {
      const bid = bm[1]; if (!BOARD_ID.test(bid)) return err(400, "Bad board id.");
      const existing = parse(await kv.hget("boards", bid));
      if (op === "set") {
        if (existing) return err(409, "That board id is already in use.");
        const board = cleanBoard(data, null); if (!board.title) return err(400, "Give the board a title.");
        board.id = bid; board.ownerId = uid; board.createdAt = now; board.updatedAt = now;
        await kv.hset("boards", { [bid]: JSON.stringify(board) }); await bump(kv, "boards"); await bump(kv, bid);
        return j(200, { ok: true });
      }
      if (!existing || typeof existing !== "object") return err(404, "Board not found.");
      const mod = admin || existing.ownerId === uid;
      if (!mod) return err(403, "Only the board owner or a moderator can change this board.");
      if (op === "update") {
        const board = cleanBoard(data, existing); if (!board.title) return err(400, "Give the board a title.");
        board.id = bid; board.ownerId = existing.ownerId; board.createdAt = existing.createdAt; board.updatedAt = now;
        await kv.hset("boards", { [bid]: JSON.stringify(board) }); await bump(kv, "boards"); await bump(kv, bid);
        return j(200, { ok: true });
      }
      if (op === "delete") {
        const posts = await values(kv, "posts:" + bid);
        const imgs = posts.map(p => p.imageId).filter(id => typeof id === "string" && IMG_ID.test(id)).map(id => "img:" + id);
        if (imgs.length) await kv.del(...imgs);
        await kv.del("posts:" + bid); await kv.hdel("boards", bid); await bump(kv, "boards"); await bump(kv, bid);
        return j(200, { ok: true });
      }
      return err(400, "Unknown operation.");
    }

    if (pm) {
      const bid = pm[1], pid = pm[2]; if (!BOARD_ID.test(bid) || !POST_ID.test(pid)) return err(400, "Bad id.");
      const board = parse(await kv.hget("boards", bid)); if (!board || typeof board !== "object") return err(404, "Board not found.");
      const mod = admin || board.ownerId === uid;
      const existing = parse(await kv.hget("posts:" + bid, pid));
      if (op === "set") {
        if (existing) return err(409, "That post id is already in use.");
        if (board.frozen) return err(403, "This board is frozen. No one can post until a moderator unfreezes it.");
        const p = cleanPostFields(data, null, board);
        if (board.requireSubject && !p.subject) return err(400, "This board requires a subject.");
        if (board.requireBody && !p.body) return err(400, "This board requires a body.");
        if (!p.subject && !p.body && !p.link && !p.imageId) return err(400, "Add a subject, body, link, or image.");
        p.id = pid; p.authorId = uid; p.createdAt = now; p.updatedAt = now; p.approved = board.requireApproval && !mod ? false : true; p.reactions = {}; p.comments = [];
        if (p.sectionId === undefined) p.sectionId = null; if (p.order === undefined) p.order = 0; if (p.sortIndex === undefined) p.sortIndex = p.order * GAP; p.pinnedAt = null; if (!p.color) p.color = "white";
        await kv.hset("posts:" + bid, { [pid]: JSON.stringify(p) }); await bump(kv, bid);
        return j(200, { ok: true });
      }
      if (!existing || typeof existing !== "object") return err(404, "Post not found.");
      const own = existing.authorId === uid;
      if (op === "delete") {
        if (!(own || mod)) return err(403, "Only the author or a moderator can delete this post.");
        if (board.frozen && !mod) return err(403, "This board is frozen.");
        if (existing.imageId && IMG_ID.test(existing.imageId)) await kv.del("img:" + existing.imageId);
        await kv.hdel("posts:" + bid, pid); await bump(kv, bid);
        return j(200, { ok: true });
      }
      if (op === "update") {
        const keys = Object.keys(data); const p = { ...existing };
        if (keys.length === 1 && keys[0] === "reactions") {
          if (board.frozen) return err(403, "This board is frozen. Reactions are off.");
          if (!board.reactions || board.reactions === "none") return err(403, "Reactions are off for this board.");
          if (board.reactions === "grade" && !mod) return err(403, "Only moderators can grade.");
          const r = data.reactions && typeof data.reactions === "object" ? data.reactions : {};
          if (Object.keys(r).some(k => k !== uid)) return err(403, "You can only change your own reaction.");
          const reactions = { ...(existing.reactions || {}) };
          const v = r[uid];
          if (v == null || v === false || v === 0) delete reactions[uid];
          else if (board.reactions === "like") reactions[uid] = true;
          else if (board.reactions === "vote") reactions[uid] = v > 0 ? 1 : -1;
          else if (board.reactions === "star") reactions[uid] = Math.max(1, Math.min(5, Math.round(Number(v) || 1)));
          else reactions[uid] = Math.max(0, Math.min(100, Number(v) || 0));
          p.reactions = reactions;
        } else if (keys.length === 1 && keys[0] === "comments") {
          if (board.frozen) return err(403, "This board is frozen. Comments are off.");
          if (!board.comments) return err(403, "Comments are off for this board.");
          const next = cleanComments(data.comments); const old = Array.isArray(existing.comments) ? existing.comments : [];
          const oldById = Object.fromEntries(old.map(c => [c.id, c]));
          for (const c of next) {
            const o = oldById[c.id];
            if (!o) { c.authorId = uid; c.createdAt = now; }
            else if (o.text !== c.text || o.authorId !== c.authorId) return err(403, "Comments cannot be edited.");
          }
          for (const o of old) if (!next.some(c => c.id === o.id) && !(o.authorId === uid || mod)) return err(403, "Only the comment's author or a moderator can delete it.");
          p.comments = next;
        } else {
          if (!(own || mod)) return err(403, "Only the author or a moderator can edit this post.");
          if (board.frozen && !mod) return err(403, "This board is frozen.");
          const allowed = ["subject", "body", "link", "imageId", "imageAlt", "color", "sectionId", "order", "sortIndex", "pinnedAt", "approved", "updatedAt"];
          if (keys.some(k => !allowed.includes(k))) return err(400, "Unknown field.");
          Object.assign(p, cleanPostFields(data, existing, board));
          if ("approved" in data) { if (!mod) return err(403, "Only moderators can approve posts."); p.approved = bool(data.approved, true); }
          if ("pinnedAt" in data) { if (!mod) return err(403, "Only moderators can pin posts."); p.pinnedAt = data.pinnedAt == null ? null : num(data.pinnedAt, now); }
          if (board.requireSubject && !p.subject) return err(400, "This board requires a subject.");
          if (board.requireBody && !p.body) return err(400, "This board requires a body.");
          if (!p.subject && !p.body && !p.link && !p.imageId) return err(400, "Add a subject, body, link, or image.");
          if (keys.some(k => ["subject", "body", "link", "imageId", "imageAlt", "color"].includes(k))) p.updatedAt = now;
        }
        await kv.hset("posts:" + bid, { [pid]: JSON.stringify(p) }); await bump(kv, bid);
        return j(200, { ok: true });
      }
      return err(400, "Unknown operation.");
    }
    return err(400, "Unknown path.");
  } catch (e) {
    console.error(e);
    return err(500, "Something went wrong on the server. Try again.");
  }
}
