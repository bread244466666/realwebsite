require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Optional: `npm i compression` to gzip/brotli-free JSON responses. Server still runs without it.
let compression = null;
try { compression = require('compression'); } catch (e) { /* not installed */ }

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
  ip: { type: String }
}, { collection: 'bread' });

const Postcard = mongoose.model('Postcard', postcardSchema);

const MAX_LIMIT = 100;

// List postcards.
// Performance: images are stored as base64 data URLs inside MongoDB. Sending them inside the
// list JSON makes the response huge and uncacheable. Here the database strips them out and the
// browser fetches each one from /api/postcards/:id/image instead (cacheable, lazy-loadable).
// Privacy: the `ip` field is no longer sent to visitors.
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
          // null when the image is a data: URL (served separately); real URLs pass through
          image: {
            $cond: [{ $eq: [{ $substrBytes: ['$image', 0, 5] }, 'data:'] }, null, '$image']
          }
        }
      }
    ]);

    res.json(docs.map((d) => ({
      ...d,
      image: d.image || `/api/postcards/${d._id}/image`
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve one stored image as a real image file with long-lived caching.
app.get('/api/postcards/:id/image', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
    const doc = await Postcard.findById(req.params.id).select('image').lean();
    if (!doc || !doc.image) return res.sendStatus(404);

    const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(doc.image);
    if (!m) return res.redirect(doc.image); // plain URL stored instead of data URL

    res.set({
      'Content-Type': m[1],
      // An image never changes for a given id, so browsers/CDNs can keep it for a year.
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.send(Buffer.from(m[2], 'base64'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a postcard (unchanged behaviour: replaces an older duplicate with same title + address).
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
    // Don't echo the whole base64 image / ip back to the browser.
    res.status(201).json({ _id: saved._id, title: saved.title });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
