require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// 連線至 MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('成功連線至 MongoDB 資料庫'))
  .catch((err) => console.error('MongoDB 連線失敗:', err));

// 定義 Postcard Schema，並明確指定 collection 名稱為 'bread'
const postcardSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sourceType: { type: String, required: true }, // 'Flower' 或 'Mushroom Fight'
  address: { type: String, required: true },
  date: { type: String, required: true },
  image: { type: String, required: true }
}, { collection: 'bread' }); // 強制對應到您截圖中的 bread collection

const Postcard = mongoose.model('Postcard', postcardSchema);

// API: 取得所有明信片
app.get('/api/postcards', async (req, res) => {
  try {
    const postcards = await Postcard.find().sort({ _id: -1 });
    res.json(postcards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: 新增明信片
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
  console.log(`伺服器正在運行於 http://localhost:${PORT}`);
});