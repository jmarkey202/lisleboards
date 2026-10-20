// Vercel serverless function: serves an uploaded image by id.
import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  const id = String((req.query && req.query.id) || "");
  if (!/^i[a-z0-9]{6,24}$/.test(id)) { res.status(400).send("Bad image id"); return; }
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).send("No Redis store connected"); return; }
  const kv = new Redis({ url, token });
  const v = await kv.get("img:" + id);
  const m = typeof v === "string" ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v) : null;
  if (!m) { res.status(404).send("Not found"); return; }
  res.setHeader("content-type", m[1]);
  res.setHeader("cache-control", "public, max-age=31536000, immutable");
  res.status(200).send(Buffer.from(m[2], "base64"));
}
