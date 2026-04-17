# myfirstcode — 英文學習教育平台

## 專案說明
一套靜態 HTML 教育應用，含詞彙學習、英文新聞閱讀練習（學生端 + 教師端）與內容產生工具。全部客戶端運行，Firebase 提供即時資料庫後端。

## 檔案結構
| 檔案 | 功能 |
|------|------|
| `index.html` | 5000 英文單字學習（含 TTS 發音、搜尋、分頁） |
| `student.html` | 學生端：閱讀新聞、多選題練習、上傳答題紀錄 |
| `teacher.html` | 教師後台：查看學生成績、弱點詞彙分析 |
| `english-press.html` | 教師產生新聞練習內容並發佈到 Firebase |

## 技術堆疊
- **純原生 HTML/CSS/JavaScript**，無框架、無編譯步驟
- **Firebase Realtime Database v12.11.0**（CDN 引入）
  - 專案 ID：`news-english-ef2e4`
  - 資料庫：`asia-southeast1`
- **Web Speech API**（TTS 文字轉語音）
- **Google Fonts**：Playfair Display、Source Serif 4、Noto Serif TC

## 部署方式
- 無需 build，直接在瀏覽器開啟 HTML 檔案即可
- 靜態檔案，可部署到任何靜態托管服務（GitHub Pages 等）
- GitHub：`https://github.com/f88012/english-press.git`

## 設計規範
- **風格**：報紙/學術風格 UI，米白紙色背景 (`#f5f0e8`)、深棕墨水色 (`#1a1208`)
- **字體**：標題用 Playfair Display、正文用 Source Serif 4、中文用 Noto Serif TC
- **響應式**：Mobile-first，斷點 480px，使用 `clamp()` 做流暢縮放
- **CSS 變數**：顏色定義集中在 `:root`，修改顏色請用 CSS 變數

## 程式碼慣例
- 所有邏輯寫在同一個 HTML 檔案的 `<script>` 區塊內（Single File App）
- 不引入外部 JS 框架（React、Vue 等）
- 使用 ES6+ 語法（`const`/`let`、arrow function、template literals）
- Firebase API Key 不能寫死在程式碼裡（歷史有過一次安全性修復，請注意）

## iOS 相容性（重要）
- Web Speech API 在 iOS Safari 需要使用者手勢才能觸發
- 音訊相關功能需維持「TTS-first」架構（已多次迭代修復，不要任意改動）
- 若修改 `speak()` 或 `tts()` 函數，務必在 iOS Safari 實機測試

## 注意事項
- `extracted_index_line3.html` 是備份檔，不需要維護
- Firebase Security Rules 保護資料存取，API Key 本身是公開識別碼
- `index.html` 內嵌 2,778 個單字資料，修改前注意檔案大小（已 245 KB）
