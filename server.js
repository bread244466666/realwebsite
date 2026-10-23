require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { downloadImage } = require('./remote-image');

// Optional packages (the server still runs without them):
//   npm i compression   -> compresses API responses
//   npm i sharp         -> lets the server create small thumbnails of the postcard pictures
let compression = null;
try { compression = require('compression'); } catch { /* not installed */ }
let sharp = null;
try { sharp = require('sharp'); } catch { /* not installed */ }

const PORT = process.env.PORT || 3000;

// hCaptcha: the secret key lives only on the server (in .env / hosting settings), never in the web page.
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || '';
const HCAPTCHA_SITEKEY = process.env.HCAPTCHA_SITEKEY || '59187592-c888-410a-a9ee-f92a10ccea82';
const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';
if (!HCAPTCHA_SECRET) console.warn('HCAPTCHA_SECRET is not set: new postcards will be refused until it is.');

// Ask hCaptcha whether the visitor really solved the challenge. Returns true/false, or null if hCaptcha could not be reached.
async function verifyCaptcha(token, ip) {
  const form = new URLSearchParams({ secret: HCAPTCHA_SECRET, response: token, sitekey: HCAPTCHA_SITEKEY });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  try {
    const res = await fetch(HCAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.warn('hCaptcha check failed:', err.message);
    return null;
  }
}
const MONGODB_URI = process.env.MONGODB_URI;

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------
// The website calls this API from its own address (relative /api/... URLs), so no other website
// needs access. Add more addresses with CORS_ORIGINS="https://a.com,https://b.com" if you ever do.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'https://pikmin.tech,https://www.pikmin.tech')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MAX_LIMIT = 100;
const SOURCE_TYPES = new Set(['Flower', 'Mushroom Fight']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_TYPES = 'jpeg|png|webp|gif|avif'; // photo formats only (no SVG: it can carry scripts)
const DATA_URL = new RegExp(`^data:(image/(?:${IMAGE_TYPES}));base64,(.*)$`, 's');
const MAX_IMAGE_CHARS = 3_000_000; // an uploaded picture, as text
const MAX_THUMB_CHARS = 400_000;
const YEAR = 'public, max-age=31536000, immutable';

// The two grid sizes. The page offers both and the browser downloads the one that fits its screen.
const THUMBS = { thumb: { width: 480, quality: 72 }, thumbSm: { width: 320, quality: 70 } };
const EMPTY = { $in: [null, ''] };

// ---------------------------------------------------------------------------------------------
// App + database
// ---------------------------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // the site sits behind Cloudflare / a proxy
if (compression) app.use(compression());
app.use(express.json({ limit: '4mb' })); // a 1200px WebP picture + thumbnails is well under 1 MB
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }));

const postcardSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sourceType: { type: String, required: true },
  address: { type: String, required: true },
  date: { type: String, required: true },
  image: { type: String, required: true },
  thumb: { type: String },            // 480px version for the grid cards
  thumbSm: { type: String },          // 320px version (desktop screens show cards at ~290px)
  ip: { type: String }
}, { collection: 'bread' });

const Postcard = mongoose.model('Postcard', postcardSchema);

// Connect once and make sure the sort index exists.
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('成功連線至 MongoDB 資料庫 (postcard)');
    await Postcard.collection.createIndex({ _id: -1 });
    backfillThumbs().catch((e) => console.error('[thumbs] backfill stopped:', e.message));
  })
  .catch((err) => console.error('MongoDB 連線失敗:', err));

// ---------------------------------------------------------------------------------------------
// Input checks (everything from a visitor is treated as untrusted)
// ---------------------------------------------------------------------------------------------
function toInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isNaN(n) ? fallback : n;
}

// Text must really be text (an object such as {"$ne": null} would otherwise reach the database).
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

// A picture is either an uploaded photo (data: address) or a normal http(s) web address.
function cleanImage(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('data:')) {
    return value.length <= MAX_IMAGE_CHARS && DATA_URL.test(value) ? value : null;
  }
  try {
    const url = new URL(value);
    const okProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    return okProtocol && value.length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}

function cleanThumb(value) {
  const ok = typeof value === 'string' && value.length <= MAX_THUMB_CHARS &&
    value.startsWith('data:image/webp;base64,') && DATA_URL.test(value);
  return ok ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Thumbnails (need `sharp`)
// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The picture's bytes: decoded from an uploaded data: address, or downloaded (safely) from the web.
async function imageBufferFor(src) {
  const match = DATA_URL.exec(src || '');
  if (match) return Buffer.from(match[2], 'base64');
  if (/^https?:\/\//i.test(src || '')) {
    const { buffer } = await downloadImage(src);
    return buffer;
  }
  throw new Error('unsupported image');
}

async function thumbFromBuffer(buffer, field) {
  const { width, quality } = THUMBS[field];
  const out = await sharp(buffer, { limitInputPixels: 50_000_000 })
    .rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
    .webp({ quality }).toBuffer();
  return 'data:image/webp;base64,' + out.toString('base64');
}

// Make whichever thumbnails a postcard is missing and save them. Returns the ones just made.
async function ensureThumbs(doc) {
  const missing = Object.keys(THUMBS).filter((field) => !doc[field]);
  if (missing.length === 0) return {};
  const buffer = await imageBufferFor(doc.image);
  const $set = {};
  for (const field of missing) $set[field] = await thumbFromBuffer(buffer, field);
  await Postcard.updateOne({ _id: doc._id }, { $set });
  return $set;
}

// Guard rails around ensureThumbs: one job per picture at a time, a few jobs at once overall, and
// a broken picture is left alone for 10 minutes instead of being retried by every visitor.
const inflight = new Map();
const failedUntil = new Map();
const MAX_JOBS = 4;
const FAIL_PAUSE_MS = 10 * 60 * 1000;
let activeJobs = 0;

async function ensureThumbsOnce(doc, { wait = false } = {}) {
  const id = String(doc._id);
  if ((failedUntil.get(id) ?? 0) > Date.now()) throw new Error('recently failed');
  while (activeJobs >= MAX_JOBS && !inflight.has(id)) {
    if (!wait) throw new Error('busy');
    await sleep(200);
  }
  if (inflight.has(id)) return inflight.get(id);
  activeJobs++;
  const job = ensureThumbs(doc)
    .catch((e) => { failedUntil.set(id, Date.now() + FAIL_PAUSE_MS); throw e; })
    .finally(() => { activeJobs--; inflight.delete(id); });
  inflight.set(id, job);
  return job;
}

// When the server starts, create thumbnails for every postcard that doesn't have them yet (uploaded
// pictures AND pictures that live on other websites), newest first, one at a time. Visitors then
// never wait for a thumbnail to be made.
const backfill = { state: sharp ? 'waiting' : 'disabled', created: 0, failed: 0 };
async function backfillThumbs() {
  if (!sharp) {
    console.warn('[thumbs] "sharp" is not installed, so grid pictures stay full size. Fix: npm i sharp');
    return;
  }
  backfill.state = 'running';
  let before = null; // walk the collection once, from newest to oldest
  for (;;) {
    const query = { image: { $regex: '^(data:image/|https?://)' }, $or: [{ thumb: EMPTY }, { thumbSm: EMPTY }] };
    if (before) query._id = { $lt: before };
    const batch = await Postcard.find(query).select('_id image thumb thumbSm').sort({ _id: -1 }).limit(10).lean();
    if (batch.length === 0) break;
    for (const doc of batch) {
      try {
        await ensureThumbsOnce(doc, { wait: true });
        backfill.created++;
      } catch (e) {
        backfill.failed++;
        console.warn('[thumbs] skipped', String(doc._id), e.message);
      }
    }
    before = batch.at(-1)._id;
    await sleep(50); // be gentle with the CPU
  }
  backfill.state = 'done';
  console.log(`[thumbs] finished: ${backfill.created} created, ${backfill.failed} skipped`);
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------
// Quick check from a browser: https://your-site/api/health  ->  {"sharp":true,...}
app.get('/api/health', (req, res) => {
  res.json({ ok: true, sharp: !!sharp, compression: !!compression, thumbs: backfill });
});

function serverError(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}

// List postcards.
// Pictures are NOT put in this JSON (huge, uncacheable). Each card gets small links instead:
//   thumb / thumbSm = grid pictures,  image = the full picture for the details view.
// The `ip` field is never sent to visitors.
app.get('/api/postcards', async (req, res) => {
  try {
    const limit = Math.min(Math.max(toInt(req.query.limit, 30), 1), MAX_LIMIT);
    const skip = Math.max(toInt(req.query.skip, 0), 0);

    const docs = await Postcard.aggregate([
      { $sort: { _id: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          title: 1, sourceType: 1, address: 1, date: 1,
          isData: { $eq: [{ $substrBytes: ['$image', 0, 5] }, 'data:'] },
          hasThumb: { $gt: [{ $strLenBytes: { $ifNull: ['$thumb', ''] } }, 0] },
          hasThumbSm: { $gt: [{ $strLenBytes: { $ifNull: ['$thumbSm', ''] } }, 0] },
          // keep the big base64 text inside the database; only real http(s) addresses come out
          url: { $cond: [{ $eq: [{ $substrBytes: ['$image', 0, 5] }, 'data:'] }, null, '$image'] }
        }
      }
    ]);

    res.json(docs.map((d) => {
      const out = { _id: d._id, title: d.title, sourceType: d.sourceType, address: d.address, date: d.date };
      out.image = d.isData ? `/api/postcards/${d._id}/image` : d.url;
      // Small pictures are offered for every card (uploaded or hosted elsewhere) once they exist
      // or can be made. Without `sharp` the page simply uses the full picture.
      if (sharp || d.hasThumb) out.thumb = `/api/postcards/${d._id}/thumb`;
      if (sharp || d.hasThumbSm) out.thumbSm = `/api/postcards/${d._id}/thumb-sm`;
      return out;
    }));
  } catch (err) {
    serverError(res, err);
  }
});

function sendDataUrl(res, dataUrl, cache) {
  const match = DATA_URL.exec(dataUrl || '');
  if (!match) return false;
  res.set({ 'Content-Type': match[1], 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(match[2], 'base64'));
  return true;
}

// Send the browser to the picture's original web address (only ever a normal http(s) address).
function redirectToOriginal(res, address) {
  if (!/^https?:\/\//i.test(address)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=300');
  res.redirect(address);
}

// Full-size picture
app.get('/api/postcards/:id/image', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
    const doc = await Postcard.findById(req.params.id).select('image').lean();
    if (!doc?.image) return res.sendStatus(404);
    if (!sendDataUrl(res, doc.image, YEAR)) redirectToOriginal(res, doc.image);
  } catch (err) {
    serverError(res, err);
  }
});

// Small pictures for the grid (480px and 320px). If a postcard has none yet they are made on the
// first request and saved. If that is not possible the original picture is used instead.
function thumbRoute(field) {
  return async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
      const doc = await Postcard.findById(req.params.id).select('image thumb thumbSm').lean();
      if (!doc?.image) return res.sendStatus(404);

      if (doc[field] && sendDataUrl(res, doc[field], YEAR)) return;

      if (sharp) {
        try {
          const made = await ensureThumbsOnce(doc);
          if (made[field] && sendDataUrl(res, made[field], YEAR)) return;
        } catch { /* fall back to the original picture below */ }
      }
      if (!sendDataUrl(res, doc.image, 'public, max-age=3600')) redirectToOriginal(res, doc.image);
    } catch (err) {
      serverError(res, err);
    }
  };
}
app.get('/api/postcards/:id/thumb', thumbRoute('thumb'));
app.get('/api/postcards/:id/thumb-sm', thumbRoute('thumbSm'));

// Add a postcard (same behaviour as before: replaces an older duplicate with the same title + address).
// Only the known fields are accepted, and each one is checked; anything else in the request is ignored.
app.post('/api/postcards', async (req, res) => {
  try {
    const body = req.body ?? {};
    const title = cleanText(body.title, 200);
    const address = cleanText(body.address, 300);
    const image = cleanImage(body.image);
    const sourceType = SOURCE_TYPES.has(body.sourceType) ? body.sourceType : null;
    const date = typeof body.date === 'string' && DATE_PATTERN.test(body.date) ? body.date : null;
    if (!title || !address || !image || !sourceType || !date) {
      return res.status(400).json({ error: 'Invalid postcard data' });
    }

    const clientIp = String(req.headers['cf-connecting-ip'] ||
                            req.headers['x-forwarded-for']?.split(',')[0] ||
                            req.ip || 'unknown').trim().slice(0, 64);

    // The visitor must have solved the hCaptcha challenge (a token can only be used once).
    if (!HCAPTCHA_SECRET) return res.status(503).json({ error: 'Captcha is not configured' });
    const token = typeof body.captchaToken === 'string' ? body.captchaToken.slice(0, 4096) : '';
    if (!token) return res.status(400).json({ error: 'Captcha required' });
    const human = await verifyCaptcha(token, clientIp);
    if (human === null) return res.status(503).json({ error: 'Captcha check unavailable, try again' });
    if (!human) return res.status(403).json({ error: 'Captcha failed' });

    const duplicates = await Postcard.find({ title: { $eq: title }, address: { $eq: address } })
      .select('_id').sort({ _id: 1 }).lean();
    if (duplicates.length > 0) {
      await Postcard.findByIdAndDelete(duplicates[0]._id);
    }

    const saved = await new Postcard({
      title, sourceType, address, date, image,
      thumb: cleanThumb(body.thumb), thumbSm: cleanThumb(body.thumbSm),
      ip: clientIp
    }).save();
    res.status(201).json({ _id: saved._id, title: saved.title });

    // Make the small pictures in the background (for pictures added by web address, or if the
    // browser did not send them). Failures are fine: they are made on first view instead.
    if (sharp) ensureThumbsOnce(saved.toObject()).catch(() => { /* retried on first view */ });
  } catch (err) {
    serverError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
