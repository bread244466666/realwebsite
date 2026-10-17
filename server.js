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

// 連線至 MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('成功連線至 MongoDB 資料庫 (postcard)'))
  .catch((err) => console.error('MongoDB 連線失敗:', err));

// 定義 Postcard Schema，加入解除檢舉狀態的追蹤欄位
const postcardSchema = new mongoose.Schema({
  title: { type: String, required: true },
  sourceType: { type: String, required: true }, 
  address: { type: String, required: true },
  date: { type: String, required: true },
  image: { type: String, required: true },
  ip: { type: String },
  reports: { type: Number, default: 0 },         // 檢舉次數
  flagged: { type: Boolean, default: false },     // 是否被標記為不合法（隱藏中）
  reportedBy: { type: [String], default: [] },    // 記錄檢舉過的用戶 IP
  hasBeenResolved: { type: Boolean, default: false } // 關鍵：是否已經被解決過（解決後永久免疫）
}, { collection: 'bread' });

const Postcard = mongoose.model('Postcard', postcardSchema);

// API 路由：取得所有明信片（只回傳未被檢舉隱藏的）
app.get('/api/postcards', async (req, res) => {
  try {
    const postcards = await Postcard.find({ flagged: false }).sort({ _id: -1 });
    res.json(postcards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 路由：新增明信片（自動檢查重複並刪除舊資料）
app.post('/api/postcards', async (req, res) => {
  try {
    const clientIp = req.headers['cf-connecting-ip'] || 
                     req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.ip;

    const { title, address } = req.body;

    // 檢查是否有完全相同的明信片（比對標題與地址）
    const duplicates = await Postcard.find({ title: title, address: address }).sort({ _id: 1 });
    
    if (duplicates.length > 0) {
      const oldestId = duplicates[0]._id;
      await Postcard.findByIdAndDelete(oldestId);
    }

    const postcardData = {
      ...req.body,
      ip: clientIp
    };

    const newPostcard = new Postcard(postcardData);
    const savedPostcard = await newPostcard.save();
    res.status(201).json(savedPostcard);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API 路由：檢舉明信片
app.post('/api/postcards/:id/report', async (req, res) => {
  try {
    const postcardId = req.params.id;
    const clientIp = req.headers['cf-connecting-ip'] || 
                     req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.ip;

    const postcard = await Postcard.findById(postcardId);
    if (!postcard) {
      return res.status(404).json({ error: '找不到該明信片' });
    }

    // 檢查：如果該明信片已經被解決過（hasBeenResolved 為 true），則永遠不能再被檢舉
    if (postcard.hasBeenResolved) {
      return res.status(400).json({ error: '此明信片先前已被檢舉並解除封鎖，無法再次被檢舉。' });
    }

    // 檢查該 IP 是否已經檢舉過
    if (postcard.reportedBy.includes(clientIp)) {
      return res.status(400).json({ error: '您已經檢舉過此明信片，無法重複檢舉' });
    }

    postcard.reports += 1;
    postcard.reportedBy.push(clientIp);

    if (postcard.reports >= 3) {
      postcard.flagged = true;
    }

    await postcard.save();
    res.json({ message: '檢舉成功', reports: postcard.reports, flagged: postcard.flagged });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API 路由：管理員將被檢舉的明信片「解除封鎖 / 解決（Resolve）」
app.post('/api/postcards/:id/resolve', async (req, res) => {
  try {
    const postcardId = req.params.id;
    const postcard = await Postcard.findById(postcardId);
    
    if (!postcard) {
      return res.status(404).json({ error: '找不到該明信片' });
    }

    // 將狀態重置並標記為「已解決」，從此免疫所有未來檢舉
    postcard.flagged = false;          // 恢復顯示
    postcard.reports = 0;             // 歸零檢舉數
    postcard.reportedBy = [];         // 清空歷史檢舉名單
    postcard.hasBeenResolved = true;  // 標記為已解決，永久不能再被檢舉

    await postcard.save();
    res.json({ message: '明信片已成功解除封鎖，且未來將無法再被檢舉。', postcard });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`後端伺服器正在運行於 http://localhost:${PORT}`);
});
