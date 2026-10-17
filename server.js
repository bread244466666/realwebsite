require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.set('trust proxy', true); 
app.use(express.json({ limit: '15mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
  .then(() => console.log('成功連線至 MongoDB 資料庫 (postcard)'))
  .catch((err) => console.error('MongoDB 連線失敗:', err));

const postcardSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sourceType: { type: String, required: true }, 
  address: { type: String, required: true },
  date: { type: String, required: true },
  image: { type: String, required: true },
  ip: { type: String },
  reports: { type: Number, default: 0 },
  flagged: { type: Boolean, default: false },
  reportedTokens: { type: [String], default: [] }, // 改用前端傳遞的唯一 Token 陣列防重複檢舉
  hasBeenResolved: { type: Boolean, default: false }
}, { collection: 'bread' });

const Postcard = mongoose.model('Postcard', postcardSchema);

app.get('/api/postcards', async (req, res) => {
  try {
    const postcards = await Postcard.find({ flagged: false }).sort({ _id: -1 });
    res.json(postcards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/postcards', async (req, res) => {
  try {
    const clientIp = req.headers['cf-connecting-ip'] || 
                     req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.ip || 'unknown';

    const { title, address } = req.body;
    const duplicates = await Postcard.find({ title: title, address: address }).sort({ _id: 1 });
    
    if (duplicates.length > 0) {
      await Postcard.findByIdAndDelete(duplicates[0]._id);
    }

    const newPostcard = new Postcard({ ...req.body, ip: clientIp });
    const savedPostcard = await newPostcard.save();
    res.status(201).json(savedPostcard);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 檢舉 API（接收前端產生的 uniqueToken）
app.post('/api/postcards/:id/report', async (req, res) => {
  try {
    const postcardId = req.params.id;
    const { clientToken } = req.body; // 從前端接收專屬識別碼

    const postcard = await Postcard.findById(postcardId);
    if (!postcard) {
      return res.status(404).json({ error: '找不到該明信片' });
    }

    if (postcard.hasBeenResolved) {
      return res.status(400).json({ error: '此明信片已獲得永久免疫，無法再次被檢舉。' });
    }

    if (clientToken && postcard.reportedTokens.includes(clientToken)) {
      return res.status(400).json({ error: '您已經檢舉過此明信片了！' });
    }

    postcard.reports += 1;
    if (clientToken) {
      postcard.reportedTokens.push(clientToken);
    }

    if (postcard.reports >= 3) {
      postcard.flagged = true;
    }

    await postcard.save();
    res.json({ message: '檢舉成功', reports: postcard.reports, flagged: postcard.flagged });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
