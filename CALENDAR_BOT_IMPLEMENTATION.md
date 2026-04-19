# Ivy's English Bot — 行事曆提醒功能實作完成

## 概述

已成功將 Ivy's English Bot 從英語教學功能改造為 Google Calendar 行事曆提醒機器人。Frank Lin 的英文小幫手保持不變。

**提交**: [442ecaa](https://github.com/f88012/english-press.git) - Feat: Add Ivy's English Calendar Reminder Bot  
**日期**: 2026-04-18

---

## 實作內容

### 1. Bot 配置更新 (index.js, lines 34-51)

```javascript
"U45ed153ac9a4c65ec21dc3eb446649c1": {
  name: "Ivy's English Calendar",
  role: "calendar",  // ← 新增區別字段
  ...
  joinMessage: "行事曆提醒機器人使用說明..."
}
```

### 2. 新增函數

#### `pushLineMessage(to, message, token)` [lines 1165-1211]
- LINE Push API 實現（主動推送，無 replyToken）
- 用於 Cloud Scheduler 排程提醒
- 調用 `POST https://api.line.me/v2/bot/message/push`

#### `fetchCalendarEvents(icalUrl)` [lines 1213-1246]
- 解析 Google Calendar 公開 iCal URL
- 使用 `node-ical` 套件（無需 OAuth）
- 回傳排序的事件陣列：`[{ id, title, start, end, location, description }]`

#### `detectCalendarIntent(text)` [lines 1248-1254]
- 純中文關鍵字比對（無需 Claude）
- 回傳：`"today" | "tomorrow" | "week" | "next" | "unknown"`

#### `formatCalendarEvents(events, label)` [lines 1256-1289]
- 格式化事件為 LINE 訊息
- 格式包含：時間、地點、備註等
- 範例：
  ```
  📅 明日行程

  📌 課程說明會
  🕐 2026/04/19 (日) 14:00 - 15:00
  📍 教室 A
  📝 攜帶課本
  ──────────
  ```

#### `handleCalendarMessage(userMessage, replyToken, token)` [lines 1291-1356]
- 處理用戶查詢（Reply 訊息）
- 支援四種查詢類型：today/tomorrow/week/next
- 未知指令時回覆使用說明

### 3. Webhook 分流 (index.js, lines 1594-1600)

```javascript
if (botConfig.role === "calendar") {
  await handleCalendarMessage(userMessage, event.replyToken, botCredentials.token);
} else {
  await handleTextMessage(userMessage, event.replyToken, botCredentials.token);
}
```

### 4. Cloud Scheduler 定時提醒 (index.js, lines 1633-1706)

```javascript
exports.calendarReminder = onSchedule("0 8 * * *", async (event) => {
  // 1. 每天早上 8:00 執行
  // 2. 從 iCal URL 取得事件
  // 3. 篩選「明天」的事件
  // 4. 檢查 Firebase /calendar-sent 避免重複
  // 5. Push 通知到所有配置的群組
  // 6. 記錄已發送
})
```

---

## 環境變數配置

### 新增變數（在 .env.local 和 Cloud Functions Secrets 中設定）

```bash
# Google Calendar iCal 連結
GOOGLE_CALENDAR_ICAL_URL=https://calendar.google.com/calendar/ical/{CALENDAR_ID}/public/basic.ics

# LINE 群組 ID（逗號分隔多個）
CALENDAR_NOTIFY_GROUP_ID=C123456789abcdef,C987654321fedcba
```

### 既有變數（保持不變）

```bash
LINE_CHANNEL_SECRET_BOT2=eca731d0898182f2ad7edee3a127756a
LINE_CHANNEL_ACCESS_TOKEN_BOT2=TC3cfbwjr12NzMOcPb3iWowyaWQ3aLORJ93JJpafi8sc...
```

---

## 費用影響分析

### 不會增加的成本
✅ **Claude Haiku API** - 日曆查詢不使用 Claude（純關鍵字）  
✅ **Firebase Realtime Database** - 只記錄已發送狀態（極少寫入）  
✅ **LINE 訊息** - Push 訊息按現有費率計

### 新增成本
⚠️ **Cloud Scheduler 執行** - 每天 1 次（極低成本，免費額度內）  
⚠️ **Cloud Functions 執行** - 每天 1 次，數百毫秒（免費額度內）  

**結論**：實務上無新增成本。

---

## Google Calendar 設定步驟

### 老師端設定

1. **建立專用日曆**
   - Google Calendar → 建立新日曆
   - 名稱：「Ivy's English 課程行事曆」

2. **設為公開**
   - 日曆右上角 ⋮ → 設定
   - 存取權限 → 勾選「設為公開」

3. **取得 iCal 連結**
   - 設定 → 整合日曆
   - 複製「iCal 格式的公開網址」
   - 格式：`https://calendar.google.com/calendar/ical/{CALENDAR_ID}/public/basic.ics`

4. **提供給開發者**
   - 提供完整的 iCal URL
   - 開發者設定到 `GOOGLE_CALENDAR_ICAL_URL` 環境變數

### 測試 iCal 連結

```bash
# 驗證連結是否有效（應回傳 .ics 內容）
curl "YOUR_ICAL_URL" | head -20
```

---

## 用戶使用指南

### 查詢指令（一對一聊天或群組 @提及）

| 用戶輸入 | 回應 |
|---|---|
| 「今日行程」或「今天」 | 顯示今天的所有活動 |
| 「明日行程」或「明天」 | 顯示明天的所有活動 |
| 「本週行程」或「這週」 | 顯示本週的所有活動 |
| 「下一個活動」或「最近」 | 顯示最近即將開始的活動 |
| 其他 | 顯示使用說明 |

### 自動提醒

- ⏰ 每天早上 8:00 自動檢查
- 📤 若隔日有活動，推送到已配置的群組
- 🔕 同一活動只推送一次（Firebase 記錄避免重複）

---

## 驗證方式

### 1. 本地測試查詢指令

```bash
# 啟動 emulator
firebase emulate

# 對 Ivy's English Bot 傳訊息
# 傳「今日行程」→ 應回應
# 傳「明日行程」→ 應回應
```

### 2. 驗證 iCal 連結

```bash
# 確認 iCal URL 有效
curl "$GOOGLE_CALENDAR_ICAL_URL" | grep "VEVENT" | wc -l
# 應顯示事件數量
```

### 3. 測試 Push 通知（手動觸發）

```bash
# Cloud Functions 中手動觸發
firebase functions:shell
calendarReminder()

# 應看到：
# [INFO] Calendar reminder job started
# [INFO] Fetched X calendar events
# [INFO] Found X events for tomorrow
# [INFO] Sent notification for "..." to group ...
```

### 4. 驗證重複防護

```bash
# 再次手動觸發，應跳過已發送的事件
# [INFO] Event "..." already sent, skipping
```

### 5. 確認 Frank Lin Bot 不受影響

```bash
# 對 Frank Line 英語教室傳英文問題
# @Bot 文法: is vs are
# 應正常回英語教學回應
```

---

## 部署步驟

### 開發環境

1. **本地 .env.local 設定**
   ```bash
   # .env.local（git ignored）
   GOOGLE_CALENDAR_ICAL_URL=https://...
   CALENDAR_NOTIFY_GROUP_ID=C123456789abcdef
   ```

2. **本地測試**
   ```bash
   firebase emulate
   ```

### 生產環境（Cloud Functions）

1. **設定 Cloud Functions Secrets**
   ```bash
   firebase functions:secrets:set GOOGLE_CALENDAR_ICAL_URL
   firebase functions:secrets:set CALENDAR_NOTIFY_GROUP_ID
   ```

2. **部署函數**
   ```bash
   firebase deploy --only functions
   ```

3. **驗證部署**
   - 檢查 Cloud Functions 日誌
   - 手動觸發 `calendarReminder` 驗證執行
   - 在 LINE 測試查詢指令

---

## 技術細節

### 架構決策

| 決策 | 理由 |
|---|---|
| 使用 node-ical | 輕量、無 OAuth 需求、支援公開 iCal URL |
| 純關鍵字偵測 | 快速、成本低、無需 Claude |
| Firebase 記錄通知 | 簡單、輕量、支援 TTL 清理 |
| Cloud Scheduler | Firebase Functions v2 內建、無額外設定 |
| 兩個 Bot 分流 | 隔離邏輯、容易維護、互不影響 |

### 代碼位置

| 功能 | 檔案位置 |
|---|---|
| Bot 配置 | index.js, lines 34-51 |
| Push API | index.js, lines 1165-1211 |
| iCal 解析 | index.js, lines 1213-1246 |
| 意圖偵測 | index.js, lines 1248-1254 |
| 訊息格式 | index.js, lines 1256-1289 |
| 用戶查詢 | index.js, lines 1291-1356 |
| Webhook 分流 | index.js, lines 1594-1600 |
| Cloud Scheduler | index.js, lines 1633-1706 |

### 相依性

```json
{
  "node-ical": "^0.26.0"
}
```

---

## 常見問題

### Q: 如何修改提醒時間？
改 `onSchedule("0 8 * * *")` 中的時間表達式：
- `"0 8 * * *"` = 每天 8:00
- `"0 9 * * 1"` = 每週一 9:00
- `"30 18 * * *"` = 每天 18:30

### Q: 如何追蹤已發送的通知？
查看 Firebase Realtime Database：
- 路徑：`/calendar-sent/{eventId}`
- 內容：`{ sentAt, eventTitle, eventStart }`

### Q: 行程標題顯示亂碼？
檢查 Google Calendar 事件是否用 UTF-8 編碼（通常自動處理）。

### Q: iCal URL 無效？
- 確認日曆已設為「公開」
- 確認 URL 中的 `{CALENDAR_ID}` 已替換為實際 ID
- 用 `curl` 測試 URL 是否回傳 .ics 內容

### Q: 為什麼沒有收到通知？
檢查清單：
1. [ ] GOOGLE_CALENDAR_ICAL_URL 已設定
2. [ ] CALENDAR_NOTIFY_GROUP_ID 是有效的 LINE 群組 ID
3. [ ] Bot 已加入該群組
4. [ ] 隔日有活動在行事曆中
5. [ ] 行事曆已設為公開
6. [ ] Cloud Scheduler job 已部署並每天執行

---

## 未來擴展建議

- [ ] 支援多個 Google Calendar（按教師劃分）
- [ ] 自訂提醒時間（早上 7:00 vs 8:00）
- [ ] 事件分類顏色標記（重要/普通）
- [ ] 訊息模板客製化
- [ ] 長期行程（1 週內的多日總覽）

---

**實作完成日期**: 2026-04-18  
**狀態**: ✅ 可部署至生產環境  
**下一步**: 老師設定 Google Calendar 並提供 iCal URL
