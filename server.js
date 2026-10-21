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
  })
  .catch((err) => console.error('MongoDB 連線失敗:', err));

const postcardSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sourceType: { type: String, required: true },
  address: { type: String, required: true },
  date: { type: String, required: true },
  image: { type: String, required: true },
  thumb: { type: String },            // small (480px) version used by the grid cards
  ip: { type: String }
}, { collection: 'bread' });

const Postcard = mongoose.model('Postcard', postcardSchema);

const MAX_LIMIT = 100;
const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.*)$/s;
const YEAR = 'public, max-age=31536000, immutable';

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
          // keep the big base64 text inside the database; only real http(s) addresses come out
          url: { $cond: [{ $eq: [{ $substrBytes: ['$image', 0, 5] }, 'data:'] }, null, '$image'] }
        }
      }
    ]);

    res.json(docs.map((d) => {
      const out = { _id: d._id, title: d.title, sourceType: d.sourceType, address: d.address, date: d.date };
      if (d.isData) {
        out.image = `/api/postcards/${d._id}/image`;
        out.thumb = `/api/postcards/${d._id}/thumb`;
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

// Small picture for the grid. Older postcards have no thumbnail yet: if `sharp` is installed it is
// made on the first request and saved, otherwise the full picture is sent (short cache so it can
// be replaced later).
app.get('/api/postcards/:id/thumb', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
    const doc = await Postcard.findById(req.params.id).select('image thumb').lean();
    if (!doc || !doc.image) return res.sendStatus(404);

    if (doc.thumb && sendDataUrl(res, doc.thumb, YEAR)) return;

    const m = DATA_URL.exec(doc.image);
    if (!m) return res.redirect(doc.image);

    if (sharp) {
      try {
        const buf = await sharp(Buffer.from(m[2], 'base64'))
          .rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72 }).toBuffer();
        const thumb = 'data:image/webp;base64,' + buf.toString('base64');
        await Postcard.updateOne({ _id: req.params.id }, { $set: { thumb } });
        return sendDataUrl(res, thumb, YEAR);
      } catch (e) { /* fall through to the full picture */ }
    }
    sendDataUrl(res, doc.image, 'public, max-age=3600');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
