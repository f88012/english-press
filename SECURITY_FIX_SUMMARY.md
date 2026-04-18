# 安全修復總結 - 2026-04-17

## 問題描述

在準備推送代碼到 GitHub 時，發現了 **關鍵安全漏洞**：前一個提交 (3e6d88b) 包含硬編碼的敏感憑證直接寫在源代碼中。

### 暴露的敏感信息

以下憑證被硬編碼在 `functions/index.js`：

```javascript
const DEFAULT_LINE_CHANNEL_SECRET = "8af2c8215449d03eabb85d583efa37c8";
const DEFAULT_LINE_ACCESS_TOKEN = "NFOlVbR9wZJTsTyIme9raVuSWORjUjuAPF+HMMX7DaRhceQ9...";
const DEFAULT_LINE_CHANNEL_SECRET_BOT2 = "eca731d0898182f2ad7edee3a127756a";
const DEFAULT_LINE_ACCESS_TOKEN_BOT2 = "TC3cfbwjr12NzMOcPb3iWowyaWQ3aLORJ93JJpafi8sc...";
const DEFAULT_ANTHROPIC_API_KEY = "sk-ant-api03-zxYO2Ww0cW3R0H8x4N9Z19zcYNPzqv5iZT3l...";
```

這意味著如果推送到公開的 GitHub 倉庫，任何人都可以：
- 訪問 LINE Bot 帳戶
- 冒充兩個教學機器人
- 使用 Anthropic Claude API（產生費用）

## 解決方案

### 1. 代碼重構

**移除硬編碼憑證**
- 刪除所有 `DEFAULT_*` 常數定義
- 改用環境變數讀取機制

**新增助手函數**

```javascript
// 從環境變數讀取憑證，缺失時拋出錯誤
function getCredential(envVarName) {
  const value = process.env[envVarName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${envVarName}`);
  }
  return value;
}

// 為特定 Bot 取得配置中的憑證
function getBotCredentials(botConfig) {
  return {
    secret: getCredential(botConfig.secretEnvVar),
    token: getCredential(botConfig.tokenEnvVar)
  };
}
```

**更新 BOT_CONFIG 結構**

```javascript
const BOT_CONFIG = {
  "Ubf2dcf1c5ebd1103328a7af4e9d7aee7": {
    name: "Frank Line英語教室 v2",
    secretEnvVar: "LINE_CHANNEL_SECRET",      // ← 環境變數名稱，非硬編碼值
    tokenEnvVar: "LINE_CHANNEL_ACCESS_TOKEN"
  },
  "U45ed153ac9a4c65ec21dc3eb446649c1": {
    name: "Ivy's English",
    secretEnvVar: "LINE_CHANNEL_SECRET_BOT2",
    tokenEnvVar: "LINE_CHANNEL_ACCESS_TOKEN_BOT2"
  }
};
```

**更新初始化函數**

```javascript
// Claude API 初始化 - 使用 getCredential()
function initializeAnthropic() {
  if (anthropic) return;
  try {
    const apiKey = getCredential("ANTHROPIC_API_KEY");
    anthropic = new Anthropic({apiKey});
  } catch (error) {
    console.error("[ERROR] Failed to initialize Anthropic:", error.message);
    throw error;
  }
}

// Webhook 處理 - 動態載入憑證
const botCredentials = getBotCredentials(botConfig);
if (!verifyLineSignature(req, botCredentials.secret)) {
  return res.status(403).send("Signature verification failed");
}
```

### 2. 環境變數配置

**更新 .env.example**

```bash
# Bot 1: Frank Line英語教室 v2
LINE_CHANNEL_SECRET=your_frank_line_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=your_frank_line_channel_access_token

# Bot 2: Ivy's English
LINE_CHANNEL_SECRET_BOT2=your_ivys_line_channel_secret
LINE_CHANNEL_ACCESS_TOKEN_BOT2=your_ivys_line_channel_access_token

# Claude API Key (Anthropic)
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### 3. Git 歷史清理

1. 撤銷包含硬編碼憑證的舊提交 (3e6d88b)
2. 建立新的安全提交 (e56044e)：
   - 移除所有硬編碼憑證
   - 新增環境變數讀取機制
   - 更新配置檔案

## 部署步驟

### 本地開發

.env.local 已包含正確的憑證，會自動被 Cloud Functions framework 載入：

```bash
firebase emulate
```

### Cloud Functions 生產部署

使用 Firebase Secrets 安全地配置憑證：

```bash
# 設定所有必需的 Secrets
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET_BOT2
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN_BOT2
firebase functions:secrets:set ANTHROPIC_API_KEY

# 部署函數
firebase deploy --only functions
```

Cloud Functions 會自動將 Secrets 作為環境變數注入到函數執行環境。

## 提交信息

```
Fix: Remove hardcoded credentials from source code

Replace hardcoded API keys and LINE credentials with environment variable-based configuration.

Key changes:
- Removed DEFAULT_* constants
- Added getCredential() and getBotCredentials() helpers
- Updated webhook handler to load credentials from environment
- Updated .env.example with all required variable names

This prevents accidental exposure of sensitive credentials in git history.
```

- **新提交**: e56044e
- **日期**: 2026-04-17
- **分支**: main
- **狀態**: ✅ 已推送至 GitHub

## .gitignore 確認

以下文件已排除在版本控制外（不會被提交）：

```
.env.local
.env.local.test
.env.*.local
firebase.json
```

檢查：
```bash
git status
# Untracked files: line-bot-firebase/firebase.json
```

## 後續行動

1. ✅ 代碼重構完成
2. ✅ 新提交已推送至 GitHub
3. ⏳ 部署生產環境時需要設定 Cloud Functions Secrets
4. ⏳ 驗證開發和生產環境的部署成功

## 安全最佳實踐

### 什麼是好的做法 ✅

- 使用環境變數管理敏感信息
- 使用 Cloud Functions Secrets 管理生產憑證
- .gitignore 排除 .env 文件
- 定期輪換 API 密鑰
- 使用具體的 Secrets（不共用密鑰）

### 什麼是壞的做法 ❌

- 硬編碼 API 密鑰在源代碼中
- 提交 .env 文件到 Git
- 在日誌中列印敏感信息
- 共用多個環境的同一個密鑰
- 在代碼註釋中記錄密鑰

---

**修復完成日期**: 2026-04-17  
**負責人**: Claude Code + Frank  
**狀態**: ✅ 已安全推送至 GitHub
