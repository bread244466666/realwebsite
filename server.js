require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Optional packages (the server still runs without them):
//   npm i compression   -> compresses API responses
//   npm i sharp         -> lets the server create small thumbnails for older postcards
let compression = null;
try { compression = require('compression'); } catch (e) { /* not installed */ }
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* not installed */ }

const app = express();
app.set('trust proxy', true);
if (compression) app.use(compression());
app.use(express.json({ limit: '15mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Connect once (the original connected twice) and make sure the sort index exists.
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('成功連線至 MongoDB 資料庫 (postcard)');
    await Postcard.collection.createIndex({ _id: -1 });
    backfillThumbs().catch((e) => console.error('[thumbs] backfill stopped:', e.message));
  })
  .catch((err) => console.error('MongoDB 連線失敗:', err));

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

const MAX_LIMIT = 100;
const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.*)$/s;
const YEAR = 'public, max-age=31536000, immutable';

// The two grid sizes. The page offers both and the browser downloads the one that fits its screen.
const THUMBS = { thumb: { width: 480, quality: 72 }, thumbSm: { width: 320, quality: 70 } };

// Make a small WebP version of a data-URL image. Needs `sharp`.
async function makeThumb(dataUrl, field = 'thumb') {
  const m = DATA_URL.exec(dataUrl || '');
  if (!sharp || !m) throw new Error('cannot make thumbnail');
  const { width, quality } = THUMBS[field];
  const buf = await sharp(Buffer.from(m[2], 'base64'))
    .rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
    .webp({ quality }).toBuffer();
  return 'data:image/webp;base64,' + buf.toString('base64');
}

const EMPTY = { $in: [null, ''] };

// When the server starts, create thumbnails for every older postcard that doesn't have one yet,
// newest first, a few at a time. Visitors then never wait for a thumbnail to be made.
const backfill = { state: sharp ? 'waiting' : 'disabled', created: 0, failed: 0 };
async function backfillThumbs() {
  if (!sharp) {
    console.warn('[thumbs] "sharp" is not installed, so grid pictures stay full size. Fix: npm i sharp');
    return;
  }
  backfill.state = 'running';
  let before = null; // walk the collection once, from newest to oldest
  for (;;) {
    const query = { image: { $regex: '^data:image/' }, $or: [{ thumb: EMPTY }, { thumbSm: EMPTY }] };
    if (before) query._id = { $lt: before };
    const batch = await Postcard.find(query).select('_id image thumb thumbSm').sort({ _id: -1 }).limit(10).lean();
    if (batch.length === 0) break;
    for (const d of batch) {
      try {
        const $set = {};
        for (const field of Object.keys(THUMBS)) {
          if (!d[field]) $set[field] = await makeThumb(d.image, field);
        }
        await Postcard.updateOne({ _id: d._id }, { $set });
        backfill.created++;
      } catch (e) {
        backfill.failed++;
        console.warn('[thumbs] skipped', String(d._id), e.message);
      }
    }
    before = batch[batch.length - 1]._id;
    await new Promise((r) => setTimeout(r, 50)); // be gentle with the CPU
  }
  backfill.state = 'done';
  console.log(`[thumbs] finished: ${backfill.created} created, ${backfill.failed} skipped`);
}

// Quick check from a browser: https://your-site/api/health  ->  {"sharp":true,...}
app.get('/api/health', (req, res) => {
  res.json({ ok: true, sharp: !!sharp, compression: !!compression, thumbs: backfill });
});

// List postcards.
// Images live in MongoDB as base64 text. Instead of putting them in this JSON (huge, uncacheable),
// each card gets two small links:  thumb = grid picture,  image = full picture for the details view.
// The `ip` field is no longer sent to visitors.
app.get('/api/postcards', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), MAX_LIMIT);
    const skip = Math.max(parseInt(req.query.skip) || 0, 0);

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
      if (d.isData) {
        out.image = `/api/postcards/${d._id}/image`;
        if (sharp || d.hasThumb) out.thumb = `/api/postcards/${d._id}/thumb`;
        if (sharp || d.hasThumbSm) out.thumbSm = `/api/postcards/${d._id}/thumb-sm`;
      } else {
        out.image = d.url; // an external image address: use it as is
      }
      return out;
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sendDataUrl(res, dataUrl, cache) {
  const m = DATA_URL.exec(dataUrl || '');
  if (!m) return false;
  res.set({ 'Content-Type': m[1], 'Cache-Control': cache });
  res.send(Buffer.from(m[2], 'base64'));
  return true;
}

// Full-size picture
app.get('/api/postcards/:id/image', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
    const doc = await Postcard.findById(req.params.id).select('image').lean();
    if (!doc || !doc.image) return res.sendStatus(404);
    if (!sendDataUrl(res, doc.image, YEAR)) return res.redirect(doc.image);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Small pictures for the grid (480px and 320px). Older postcards may not have them yet: if `sharp`
// is installed they are made on the first request and saved, otherwise the full picture is sent
// (short cache so it can be replaced later).
function thumbRoute(field) {
  return async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
      const doc = await Postcard.findById(req.params.id).select(`image ${field}`).lean();
      if (!doc || !doc.image) return res.sendStatus(404);

      if (doc[field] && sendDataUrl(res, doc[field], YEAR)) return;

      if (!DATA_URL.test(doc.image)) return res.redirect(doc.image);

      if (sharp) {
        try {
          const thumb = await makeThumb(doc.image, field);
          await Postcard.updateOne({ _id: req.params.id }, { $set: { [field]: thumb } });
          return sendDataUrl(res, thumb, YEAR);
        } catch (e) { /* fall through to the full picture */ }
      }
      sendDataUrl(res, doc.image, 'public, max-age=3600');
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}
app.get('/api/postcards/:id/thumb', thumbRoute('thumb'));
app.get('/api/postcards/:id/thumb-sm', thumbRoute('thumbSm'));

// Add a postcard (same behaviour as before: replaces an older duplicate with the same title + address).
app.post('/api/postcards', async (req, res) => {
  try {
    const clientIp = req.headers['cf-connecting-ip'] ||
                     req.headers['x-forwarded-for']?.split(',')[0] ||
                     req.ip || 'unknown';

    const { title, address } = req.body;
    const duplicates = await Postcard.find({ title: title, address: address })
      .select('_id').sort({ _id: 1 }).lean();

    if (duplicates.length > 0) {
      await Postcard.findByIdAndDelete(duplicates[0]._id);
    }

    const newPostcard = new Postcard({ ...req.body, ip: clientIp });
    const saved = await newPostcard.save();
    res.status(201).json({ _id: saved._id, title: saved.title });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
