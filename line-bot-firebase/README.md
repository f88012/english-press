# 英文教學 LINE Bot

一個由 Claude Haiku API 驅動的 LINE Bot，提供文法問答、單字查詢、句子糾錯、寫作批改等英文教學功能。

使用 Firebase Realtime Database 快取，降低 API 成本。

---

## 🚀 快速開始

### 前置需求

- Node.js 24+ （[下載](https://nodejs.org/)）
- Firebase CLI （`npm install -g firebase-tools`）
- Google 帳號（用於 Firebase）
- LINE Developers 帳號 + Channel（[申請](https://developers.line.biz/)）
- Anthropic API 金鑰（[取得](https://console.anthropic.com/)）

### 1. 本地開發設定

```bash
# 複製環境變數範本
cp functions/.env.example functions/.env.local

# 編輯 .env.local，填入你的認證資訊
# 編輯器: nano, vim, VS Code, 等等
nano functions/.env.local
```

**填寫內容：**

```env
# LINE Developers → Your channel → Messaging API
LINE_CHANNEL_SECRET=your_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token

# Anthropic Console → API Keys
ANTHROPIC_API_KEY=sk-ant-...
```

### 2. 安裝依賴

```bash
cd functions
npm install
```

### 3. 本地測試 (Emulator)

```bash
npm run serve
```

輸出會顯示：
```
Serving at port XXXX
```

**測試 Webhook：**

使用 curl 或 Postman 發送測試請求：

```bash
curl -X POST http://localhost:5001/news-english-ef2e4/us-central1/lineWebhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: YOUR_SIGNATURE" \
  -d '{
    "events": [{
      "type": "message",
      "message": {"type": "text", "text": "文法: is vs are"},
      "replyToken": "test_token"
    }]
  }'
```

**或用 LINE 官方帳號測試：**
1. 開啟 ngrok: `ngrok http 5001`
2. 取得公開 URL（如 `https://abc123.ngrok.io`）
3. Line Developers → Webhook URL 改為 `https://abc123.ngrok.io/news-english-ef2e4/us-central1/lineWebhook`
4. 啟用 Webhook
5. 用你的 LINE Bot 傳送訊息測試

---

## 📦 部署到 Firebase

### 方式 1：使用 Firebase CLI（推薦）

```bash
# 在專案根目錄
# 設定敏感資訊（Anthropic API Key）
firebase functions:secrets:set ANTHROPIC_API_KEY

# 系統會提示輸入，貼上你的 API Key

# 部署
firebase deploy --only functions
```

**輸出會包含：**
```
Function URL (lineWebhook): https://linewebhook-xxx.a.run.app
```

### 方式 2：使用 Google Cloud Console（進階）

1. 進入 [Google Cloud Console](https://console.cloud.google.com)
2. 選擇 `news-english-ef2e4` 專案
3. 前往 Cloud Functions
4. 編輯 `lineWebhook` 函數
5. 在「執行時設定變數」中添加：
   - `ANTHROPIC_API_KEY` = 你的 API Key

---

## 🔧 LINE Developers 設定

1. **進入 [LINE Developers Console](https://developers.line.biz/)**
2. **選擇你的 Channel**
3. **Messaging API 設定**
4. **找到「Webhook URL」欄位**
5. **貼上部署後的 Function URL：**
   ```
   https://linewebhook-xxx.a.run.app
   ```
6. **驗證按鈕** — LINE 會測試連線，應顯示 ✓ 驗證成功
7. **啟用 Webhook**
   - 開啟「Use webhook」開關
   - 關閉「Auto-reply messages」（我們用 webhook 回覆）
8. **新增 Bot 為好友**
   - 掃描 QR Code 或點擊「Add this bot」
9. **測試**
   - 傳送訊息給 Bot，應收到回覆

---

## 💬 使用方式

### 📝 文法問答

```
文法: is 和 are 的差異
```

Bot 會：
- 解釋文法規則
- 舉 2-3 個例句（英中翻譯）
- 提供常見錯誤和改正

### 📚 單字查詢

```
單字: serendipity
```

Bot 會：
- 音標、詞性、中文意思
- 英文定義
- 3 個例句（英中翻譯）
- 延伸詞彙

### ✏️ 句子糾錯

```
糾錯: I go to school yesterday
```

Bot 會：
- 找出所有錯誤
- 解釋為什麼錯
- 提供正確版本
- 學習建議

### 📄 寫作批改

```
批改: [你的英文段落或文章]
```

Bot 會：
- 整體評語
- 結構分析
- 列出主要文法和用詞錯誤
- 具體改進建議

---

## 💰 成本優化

### 快取策略

- **首次查詢**：呼叫 Claude Haiku（免費額度內）
- **相同問題**：直接返回快取（完全免費）
- **快取期限**：7 天

### 成本估算

**Claude Haiku 價格**（2024）：
- 輸入：$0.80 per 1M tokens
- 輸出：$4 per 1M tokens

**估算**：
- 一般提問：~200-500 tokens
- 寫作批改：~1000-2000 tokens
- **1000 次新查詢** ≈ $0.50-$2

---

## 🗂️ 專案結構

```
line-bot-firebase/
├── functions/
│   ├── index.js              ← 核心 Webhook 邏輯
│   ├── package.json          ← 依賴列表
│   ├── .env.example          ← 環境變數範本
│   ├── .env.local            ← 本地開發祕密（不上傳）
│   └── node_modules/         ← 依賴包
├── firebase.json             ← Firebase 部署設定
├── .firebaserc               ← 專案關聯
└── README.md                 ← 本檔案
```

### functions/index.js 主要函式

| 函式 | 用途 |
|------|------|
| `detectIntent(text)` | 偵測用戶輸入意圖（文法/單字/糾錯/批改） |
| `extractContent(text, intent)` | 提取實際問題內容 |
| `callClaude(systemPrompt, userMessage, maxTokens)` | 呼叫 Claude Haiku API |
| `getCachedResponse(cacheKey)` | 查詢 Firebase 快取 |
| `setCachedResponse(cacheKey, text)` | 存入 Firebase 快取（7 天 TTL） |
| `buildPrompt(intent)` | 針對功能構建 system prompt |
| `handleTextMessage(userMessage, replyToken)` | 主流程：意圖→快取→Claude→回覆 |
| `exports.lineWebhook` | HTTP Webhook 端點 |

---

## 🐛 除錯

### 查看 Cloud Functions 日誌

```bash
firebase functions:log
```

或進入 [Firebase Console](https://console.firebase.google.com) → Functions → 日誌

### 常見問題

| 問題 | 解決方案 |
|------|--------|
| `Missing ANTHROPIC_API_KEY` | 檢查 `.env.local` 或部署時設定 Secret |
| `Signature verification failed` | 確認 `LINE_CHANNEL_SECRET` 正確 |
| `Cannot query database` | 確認 Firebase Realtime Database 已啟用 |
| Bot 不回應 | 檢查 Line Developers 的 Webhook URL 和簽名設定 |

### 本地測試常見問題

```bash
# 1. 清空快取
rm -rf node_modules/.bin/.cache

# 2. 重新安裝依賴
npm install

# 3. 檢查 .env.local 是否存在
ls -la functions/.env.local

# 4. 重啟 Emulator
npm run serve
```

---

## 📖 API 文件

- [LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/)
- [Anthropic Claude API](https://docs.anthropic.com/)
- [Firebase Functions](https://firebase.google.com/docs/functions)
- [Firebase Realtime Database](https://firebase.google.com/docs/database)

---

## 📝 授權

此專案為教育用途。依照你使用的服務條款（LINE、Firebase、Anthropic）使用。

---

## 💡 進一步改進

- [ ] 支援圖片上傳（掃描英文文本進行批改）
- [ ] 用戶進度追蹤（Firebase Firestore）
- [ ] 定期練習提醒（LINE Notify）
- [ ] 多語言支援
- [ ] Web Dashboard（查看統計數據）

---

**有問題？**

1. 檢查 [常見問題](#-除錯)
2. 查看 [Firebase Console](https://console.firebase.google.com) 日誌
3. 確認環境變數設定正確

Happy learning! 🚀
