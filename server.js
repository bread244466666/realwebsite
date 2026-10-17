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

// 定義基本的 Postcard Schema（已移除檢舉相關欄位）
const postcardSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sourceType: { type: String, required: true }, 
  address: { type: String, required: true },
  date: { type: String, required: true },
  image: { type: String, required: true },
  ip: { type: String }
}, { collection: 'bread' });

const Postcard = mongoose.model('Postcard', postcardSchema);

// API 路由：取得所有明信片
// 連線至 MongoDB 成功後，建立降冪索引以加速排序查詢
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('成功連線至 MongoDB 資料庫 (postcard)');
    // 確保 _id 索引存在，大幅提升 .sort({ _id: -1 }) 的查詢效能
    await Postcard.collection.createIndex({ _id: -1 });
  })
  .catch((err) => console.error('MongoDB 連線失敗:', err));

// API 路由：取得明信片（限制預設回傳最新 50 筆以優化效能）
app.get('/api/postcards', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50; // 可透過 ?limit= 調整，預設 50 筆
    const postcards = await Postcard.find().sort({ _id: -1 }).limit(limit);
    res.json(postcards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 路由：新增明信片（保留重複明信片自動清理舊資料的功能）
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

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
