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
  flagged: { type: Boolean, default: false },
  reportTimestamps: { type: [Date], default: [] }, // 記錄每次檢舉的時間，用來計算一天內的檢舉次數
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

// 檢舉 API：限制一天（24小時）內最多只能被檢舉 3 次
app.post('/api/postcards/:id/report', async (req, res) => {
  try {
    const postcardId = req.params.id;
    const postcard = await Postcard.findById(postcardId);
    
    if (!postcard) {
      return res.status(404).json({ error: '找不到該明信片' });
    }

    if (postcard.hasBeenResolved) {
      return res.status(400).json({ error: '此明信片已獲得永久免疫，無法再次被檢舉。' });
    }

    // 計算 24 小時（一天）內的有效檢舉次數
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    // 過濾出過去 24 小時內的檢舉紀錄
    const recentReports = postcard.reportTimestamps.filter(timestamp => new Date(timestamp) > oneDayAgo);

    if (recentReports.length >= 3) {
      return res.status(400).json({ error: '此明信片今日被檢舉次數已達上限（每日最多 3 次）。' });
    }

    // 記錄這次檢舉的時間
    postcard.reportTimestamps.push(now);

    // 如果過去 24 小時內的總檢舉次數達到 3 次，則標記隱藏
    if (postcard.reportTimestamps.length >= 3) {
      postcard.flagged = true;
    }

    await postcard.save();
    res.json({ message: '檢舉成功', count: postcard.reportTimestamps.length, flagged: postcard.flagged });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
