import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { Client, Events, GatewayIntentBits } from 'discord.js';

const {
  DISCORD_TOKEN,
  API_KEY,
  SUMMON_CHANNEL_ID,
  BANNER_CHANNEL_ID,
  PORT = '3000',
} = process.env;

if (!DISCORD_TOKEN || !API_KEY || !SUMMON_CHANNEL_ID) {
  console.error('Missing env: DISCORD_TOKEN, API_KEY and SUMMON_CHANNEL_ID are required (see .env.example)');
  process.exit(1);
}

const channelIds = {
  summon: SUMMON_CHANNEL_ID,
  banner: BANNER_CHANNEL_ID || SUMMON_CHANNEL_ID,
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, (c) => console.log(`Logged in as ${c.user.tag}`));
client.on(Events.Error, (err) => console.error('[discord] client error:', err));

// ---------- helpers ----------

function authorized(req) {
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function rateLimit(max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: 'rate limited' });
    next();
  };
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const httpsUrl = (v) => (typeof v === 'string' && v.startsWith('https://') && v.length <= 2000 ? v : undefined);

// Only whitelisted embed fields get through, with Discord's length limits applied.
function cleanEmbed(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  if (str(e.title, 256)) out.title = str(e.title, 256);
  if (str(e.description, 4096)) out.description = str(e.description, 4096);
  if (httpsUrl(e.url)) out.url = httpsUrl(e.url);
  if (Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) out.color = e.color;
  if (str(e.timestamp, 40) && !Number.isNaN(Date.parse(e.timestamp))) out.timestamp = e.timestamp;
  if (e.footer && str(e.footer.text, 2048)) out.footer = { text: str(e.footer.text, 2048) };
  if (e.image && httpsUrl(e.image.url)) out.image = { url: httpsUrl(e.image.url) };
  if (e.thumbnail && httpsUrl(e.thumbnail.url)) out.thumbnail = { url: httpsUrl(e.thumbnail.url) };
  if (Array.isArray(e.fields)) {
    out.fields = e.fields
      .slice(0, 25)
      .map((f) => ({ name: str(f?.name, 256), value: str(f?.value, 1024), inline: f?.inline === true }))
      .filter((f) => f.name && f.value);
  }
  return Object.keys(out).length ? out : null;
}

// Remember recent dedupe keys so a retry from the game never posts twice.
const seen = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
}, 60_000).unref();

// ---------- HTTP API ----------

const app = express();
app.set('trust proxy', 1);

app.get('/health', (req, res) => res.json({ ok: true, discordReady: client.isReady() }));

// Called by the Roblox server. Body: { channel: "summon" | "banner", dedupeKey?: string, payload: { embeds: [...] } }
app.post(
  '/announce',
  rateLimit(120, 60_000),
  (req, res, next) => (authorized(req) ? next() : res.status(401).json({ error: 'unauthorized' })),
  express.json({ limit: '64kb' }),
  async (req, res) => {
    const { channel = 'summon', dedupeKey, payload } = req.body ?? {};
    const channelId = channelIds[channel];
    if (!channelId) return res.status(400).json({ error: 'unknown channel' });

    const embeds = (Array.isArray(payload?.embeds) ? payload.embeds : [])
      .slice(0, 10)
      .map(cleanEmbed)
      .filter(Boolean);
    if (!embeds.length) return res.status(400).json({ error: 'no valid embeds' });

    if (typeof dedupeKey === 'string' && dedupeKey) {
      if (seen.has(dedupeKey)) return res.json({ ok: true, duplicate: true });
      seen.set(dedupeKey, Date.now());
    }

    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.isTextBased()) throw new Error('channel is not text based');
      await ch.send({ embeds, allowedMentions: { parse: [] } });
      res.json({ ok: true });
    } catch (err) {
      if (typeof dedupeKey === 'string') seen.delete(dedupeKey);
      console.error('[announce] failed:', err);
      res.status(502).json({ error: 'discord send failed' });
    }
  },
);

// Public image URL for a Roblox asset, so Discord embeds can show unit pictures.
const thumbCache = new Map(); // id -> { buf, type, expires }
app.get('/thumb/:assetId', rateLimit(300, 60_000), async (req, res) => {
  const id = req.params.assetId;
  if (!/^\d{1,20}$/.test(id)) return res.sendStatus(400);

  let hit = thumbCache.get(id);
  if (!hit || hit.expires < Date.now()) {
    try {
      const meta = await fetch(
        `https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png&isCircular=false`,
      ).then((r) => r.json());
      const item = meta?.data?.[0];
      if (item?.state !== 'Completed' || !item.imageUrl) return res.sendStatus(404);
      const img = await fetch(item.imageUrl);
      if (!img.ok) return res.sendStatus(502);
      hit = {
        buf: Buffer.from(await img.arrayBuffer()),
        type: img.headers.get('content-type') || 'image/png',
        expires: Date.now() + 3600_000,
      };
      if (thumbCache.size >= 200) thumbCache.delete(thumbCache.keys().next().value);
      thumbCache.set(id, hit);
    } catch (err) {
      console.error('[thumb] failed:', err);
      return res.sendStatus(502);
    }
  }
  res.set('Content-Type', hit.type).set('Cache-Control', 'public, max-age=3600').send(hit.buf);
});

// ---------- start / stop ----------

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

await client.login(DISCORD_TOKEN);
const server = app.listen(Number(PORT), () => console.log(`API listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close();
    client.destroy();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
