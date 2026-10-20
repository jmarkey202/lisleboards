// Vercel serverless function: all board, post, user, and image writes plus board reads.
import { Redis } from "@upstash/redis";
import { handle } from "./_core.js";

function client() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const kv = client();
  if (!kv) { res.status(500).json({ error: "No Redis store is connected. In Vercel, open Storage, create a Redis (Upstash) database, connect it to this project, then redeploy." }); return; }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const r = await handle({ method: req.method, query: req.query || {}, headers, body: body || {} }, kv, process.env);
  res.status(r.status).json(r.body);
}
