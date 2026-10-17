require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// 提高 JSON 承載限制以支援 Base64 圖片上傳
app.use(express.json({ limit: '15mb' }));
app.use(cors());

// 從環境變數讀取 MongoDB 連線字串
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// 連線至 MongoDB 資料庫
mongoose.connect(MONGODB_URI)
  .then(() => console.log('成功連線至 MongoDB 資料庫 (postcard)'))
  .catch((err) => console.error('MongoDB 連線失敗:', err));

// 定義明信片 Schema，並對應到您的 'bread' 集合 (Collection)
// 定義 Postcard Schema，並加入 ip 欄位
const postcardSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sourceType: { type: String, required: true }, // 'Flower' 或 'Mushroom Fight'
  address: { type: String, required: true },
  date: { type: String, required: true },
  image: { type: String, required: true },
  ip: { type: String } // 新增這行以接收並儲存 IP 欄位
}, { collection: 'bread' }); // 強制對應到 bread collection

const Postcard = mongoose.model('Postcard', postcardSchema);

// API 路由：取得所有明信片
app.get('/api/postcards', async (req, res) => {
  try {
    const postcards = await Postcard.find().sort({ _id: -1 });
    res.json(postcards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 路由：新增明信片
app.post('/api/postcards', async (req, res) => {
  try {
    const newPostcard = new Postcard(req.body);
    const savedPostcard = await newPostcard.save();
    res.status(201).json(savedPostcard);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
