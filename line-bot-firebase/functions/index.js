const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const https = require("https");
const {Anthropic} = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");
const crypto = require("crypto");
const express = require("express");

// ========== 憑證配置（多 Bot 支持）==========
// Load from environment variables (Cloud Functions Secrets or .env.local)
// DO NOT hardcode credentials in this file

// Bot 配置映射（用 User ID 作為 key）
// 注意：實際的 secret 和 token 從環境變數讀取，不硬編碼在此
const BOT_CONFIG = {
  "Ubf2dcf1c5ebd1103328a7af4e9d7aee7": {
    // Frank Line英語教室 v2
    name: "Frank Line英語教室 v2",
    channelId: 2009816850,
    secretEnvVar: "LINE_CHANNEL_SECRET",
    tokenEnvVar: "LINE_CHANNEL_ACCESS_TOKEN",
    joinMessage: `大家好！我是 Frank 老師的英文小幫手 👋

使用方式：
在訊息中 @Bot 並提問即可

例如：
@Bot 文法: is 和 are 的差別
@Bot 單字: serendipity

期待為大家解答英文問題！😊`
  },
  "U45ed153ac9a4c65ec21dc3eb446649c1": {
    // Ivy's English - Calendar Reminder Bot
    name: "Ivy's English Calendar",
    role: "calendar",
    channelId: 2009819826,
    secretEnvVar: "LINE_CHANNEL_SECRET_BOT2",
    tokenEnvVar: "LINE_CHANNEL_ACCESS_TOKEN_BOT2",
    joinMessage: `大家好！我是 Ivy's English 行事曆提醒機器人 📅

功能：
🔔 每天早上自動提醒隔日行程
📋 查詢今日/明日/本週行程

查詢方式（直接輸入關鍵字）：
今日行程 / 今天 → 今天的所有活動
明日行程 / 明天 → 明天的所有活動
本週行程 / 這週 → 本週的所有活動
下一個活動 → 最近即將開始的活動

期待為大家提供貼心的行程提醒！😊`
  }
};

// Helper function to get credentials from environment
function getCredential(envVarName) {
  const value = process.env[envVarName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${envVarName}`);
  }
  return value;
}

// Helper function to get bot credentials (secret and token)
function getBotCredentials(botConfig) {
  return {
    secret: getCredential(botConfig.secretEnvVar),
    token: getCredential(botConfig.tokenEnvVar)
  };
}

setGlobalOptions({maxInstances: 10});

// ========== Raw Body Capture for LINE Signature Verification ==========
// Using correct Channel Secret from firebase.json
const app = express();

// 捕捉原始 body 並保存為字符串（用於 LINE 簽章驗證）
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}));

// ========== 初始化 ==========

let lineClient;
let anthropic;
let dbRef;

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

function initializeFirebase() {
  if (dbRef) return;
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        databaseURL: "https://news-english-ef2e4-default-rtdb.asia-southeast1.firebasedatabase.app",
      });
    }
    dbRef = admin.database();
  } catch (error) {
    console.error("[ERROR] Failed to initialize Firebase:", error.message);
    throw error;
  }
}

// ========== LINE API 回覆函式 ==========

/**
 * 回覆 LINE 訊息
 * @param {string} replyToken - 回覆令牌
 * @param {object} message - 訊息物件
 * @param {string} token - LINE Channel Access Token
 * @returns {Promise}
 */
async function replyLineMessage(replyToken, message, token) {
  return new Promise((resolve, reject) => {
    if (!token) {
      console.error("[ERROR] LINE token not provided");
      return reject(new Error("LINE token is required"));
    }

    const data = JSON.stringify({
      replyToken: replyToken,
      messages: [message]
    });

    const options = {
      hostname: "api.line.me",
      port: 443,
      path: "/v2/bot/message/reply",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data, 'utf8'),
        "Authorization": `Bearer ${token}`
      }
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("[INFO] Message replied successfully");
          resolve(responseData);
        } else {
          console.error(`[ERROR] Failed to reply: ${res.statusCode}`, responseData);
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on("error", (error) => {
      console.error("[ERROR] HTTP request error:", error.message);
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

// ========== 快取函式 ==========

function generateCacheKey(intent, text) {
  const input = `${intent}:${text.toLowerCase().trim()}`;
  return crypto.createHash("md5").update(input).digest("hex");
}

async function getCachedResponse(cacheKey) {
  try {
    initializeFirebase();
    const snapshot = await dbRef.ref(`/cache/${cacheKey}`).get();
    if (!snapshot.exists()) return null;

    const data = snapshot.val();
    const createdAt = data.createdAt || 0;
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    if (now - createdAt > sevenDaysMs) {
      await dbRef.ref(`/cache/${cacheKey}`).remove();
      return null;
    }

    return data.text;
  } catch (error) {
    console.error("[ERROR] Cache read error:", error.message);
    return null;
  }
}

async function setCachedResponse(cacheKey, text) {
  try {
    initializeFirebase();
    await dbRef.ref(`/cache/${cacheKey}`).set({
      text,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error("[ERROR] Cache write error:", error.message);
  }
}

// ========== Claude API ==========

async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  try {
    initializeAnthropic();

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    const response = message.content[0].type === "text" ? message.content[0].text : "";
    return response;
  } catch (error) {
    console.error("[ERROR] Claude API error:", error.message);
    throw error;
  }
}

// ========== 文本清理 ==========

function sanitizeTextForLine(text) {
  // LINE API 支援 emoji 和多種 Unicode 字符
  // 只移除真正有問題的控制字符
  return text
    .replace(/[\r\n]+/g, '\n')  // 統一換行符
    .trim();
}

// ========== 意圖偵測 ==========

// ========== 舊版意圖偵測（保留以備用）==========
function detectIntent(text) {
  if (/^(文法|grammar)\s*[:：]/i.test(text)) return "grammar";
  if (/^(單字|word|查)\s*[:：]/i.test(text)) return "vocabulary";
  if (/^(糾錯|check|改)\s*[:：]/i.test(text)) return "error_correction";
  if (/^(批改|寫作|essay)\s*[:：]/i.test(text)) return "essay_review";

  return "unknown";
}

function extractContent(text, intent) {
  const patterns = {
    grammar: /^(文法|grammar)\s*[:：]\s*/i,
    vocabulary: /^(單字|word|查)\s*[:：]\s*/i,
    error_correction: /^(糾錯|check|改)\s*[:：]\s*/i,
    essay_review: /^(批改|寫作|essay)\s*[:：]\s*/i,
  };

  if (patterns[intent]) {
    return text.replace(patterns[intent], "").trim();
  }
  return text;
}

// ========== 智能意圖偵測（用 Claude）==========
async function detectIntentWithClaude(userMessage) {
  try {
    initializeAnthropic();

    const systemPrompt = `你是一個英文教學助手的意圖識別器。分析用戶訊息，判斷他們的真正需求，並提取關鍵內容。

分類規則（檢查訊息中是否包含關鍵詞）：

1. vocabulary（單字查詞）- 用戶想查單字的各方面資訊（支持大写开头的单字如 Serendipity、Apple 等）

   1.1 subIntent: "meaning" - 查單字的中文意思、定義
       關鍵詞：「是什麼意思」、「意思」、「定義」、「翻譯」
       例：「serendipity 是什麼意思？」或「Serendipity 是什麼意思？」

   1.2 subIntent: "pronunciation" - 查發音、怎麼唸
       關鍵詞：「怎麼唸」、「唸法」、「發音」、「音標」
       例：「ephemeral 怎麼唸」或「Ephemeral 怎麼唸」

   1.3 subIntent: "synonym" - 查同義詞、相似詞
       關鍵詞：「同義詞」、「類似詞」、「近似詞」、「同義」
       例：「ephemeral 有何同義詞？」或「Ephemeral 有何同義詞？」

   1.4 subIntent: "antonym" - 查反義詞、相反詞
       關鍵詞：「反義詞」、「相反詞」、「反義」
       例：「happy 的反義詞是什麼」或「Happy 的反義詞是什麼」

   1.5 subIntent: "example" - 查用法例句
       關鍵詞：「例句」、「怎麼用」、「用法」、「造句」、「應用」
       例：「用 ubiquitous 造句」或「用 Ubiquitous 造句」

   ⭐ 重要：提取單字時，保留用戶輸入的大小寫形式（大寫開頭或全小寫都可）
   預設 subIntent：如果沒有明確關鍵詞，預設為 "meaning"
   提取內容：單字本身（保持用戶的大小寫格式）
   → intent: "vocabulary", subIntent: "meaning|pronunciation|synonym|antonym|example", content: "serendipity" 或 "Serendipity"

2. translation（翻譯）- 用戶請求翻譯句子或文章（英譯中或中譯英）
   關鍵詞：「翻譯」、「translate」、「中文是」、「英文怎麼說」
   例：
   - 「請幫我翻譯：How are you?」
   - 「翻譯：This is a beautiful day」
   - 「'你好'英文怎麼說」
   提取內容：要翻譯的句子
   → intent: "translation", content: "How are you?"

3. grammar（文法問題）- 用戶問文法、語法規則、句子結構或選擇題

   3.1 基本文法問題
       關鍵詞：「差別」、「差異」、「怎麼用」、「用法」、「什麼」、「文法」+ 詞彙對
       例：
       - 「is 和 are 的差別」
       - 「would 和 should 的用法」
       - 「現在完成式是什麼」
       → intent: "grammar", subIntent: "explanation", content: "is 和 are 的差別"

   3.2 選擇題/填空題 ✨ 新增
       特徵：包含 ________ 或 _____ 空白、有 (A)(B)(C)(D) 選項
       例：
       - 「________ the water in the bottle ________ clean, so you can drink it.
         (A) One of; is (B) Any of; is (C) All of; is (D) None; is」
       - 「The book ________ by my teacher yesterday.
         (A) was given (B) were given (C) has been given (D) is given」
       → intent: "grammar", subIntent: "quiz", content: "[完整題目]"

4. error_correction（句子糾錯）- 用戶請求檢查或修正英文句子
   關鍵詞：「對嗎」、「改」、「修改」、「檢查」、「糾正」、「英文句子」
   例：
   - 「這句對嗎：I go to school yesterday」
   - 「請幫我改這句」
   - 「He don't like apples，這樣對嗎」
   提取內容：英文句子
   → intent: "error_correction", content: "I go to school yesterday"

4. essay_review（寫作協助）- 用戶請求批改文章或寫作範例

   4.1 subIntent: "review" - 批改、修正文章
       關鍵詞：「批改」、「修改潤飾」、「文章」、「段落」、「有什麼問題」
       例：
       - 「請幫我修改潤飾這段英文」
       - 「這篇文章有什麼問題」
       - 「幫我改一下這個句子」
       提取內容：英文段落或文章內容
       → intent: "essay_review", subIntent: "review", content: "[文章內容]"

   4.2 subIntent: "example" - 提供寫作範例或範本
       關鍵詞：「範例」、「寫個」、「給我」、「怎麼寫」、「範本」、「模板」
       例：
       - 「商業信範例：客訴回應信」
       - 「幫我寫個感謝信」
       - 「給我一封求職信的範例」
       - 「怎麼寫一個道歉信」
       提取內容：要寫什麼類型的信/文章
       → intent: "essay_review", subIntent: "example", content: "感謝信"

回覆為純 JSON（不要加 markdown 符號或其他文字）：
{
  "intent": "vocabulary|translation|grammar|error_correction|essay_review",
  "subIntent": "vocabulary 時：meaning|pronunciation|synonym|antonym|example（預設 meaning）；grammar 時：explanation|quiz（預設 explanation）；essay_review 時：review|example（預設 review）",
  "content": "提取的關鍵內容"}

規則：
- 必須回覆 JSON
- 如果無法判斷，回覆 {"intent": "unknown", "content": "原始訊息"}
- content 務必精確提取，例如單字就提取單字，句子就提取句子
- 不要有 markdown、code block 或任何其他文字`;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    const response = message.content[0].type === "text" ? message.content[0].text : "{}";

    // 清理回應（移除可能的 markdown code block）
    let cleanResponse = response.trim();
    if (cleanResponse.startsWith("```json")) {
      cleanResponse = cleanResponse.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleanResponse.startsWith("```")) {
      cleanResponse = cleanResponse.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    cleanResponse = cleanResponse.trim();

    console.log("[DEBUG] Claude intent response:", cleanResponse);

    try {
      const result = JSON.parse(cleanResponse);
      if (!result.intent || !["vocabulary", "translation", "grammar", "error_correction", "essay_review"].includes(result.intent)) {
        result.intent = "unknown";
      }

      // 根據 intent 設置 subIntent（預設值）
      if (result.intent === "vocabulary") {
        result.subIntent = result.subIntent || "meaning";
        if (!["meaning", "pronunciation", "synonym", "antonym", "example"].includes(result.subIntent)) {
          result.subIntent = "meaning";
        }
      } else if (result.intent === "grammar") {
        result.subIntent = result.subIntent || "explanation";
        if (!["explanation", "quiz"].includes(result.subIntent)) {
          result.subIntent = "explanation";
        }
      } else if (result.intent === "essay_review") {
        result.subIntent = result.subIntent || "review";
        if (!["review", "example"].includes(result.subIntent)) {
          result.subIntent = "review";
        }
      }

      console.log("[INFO] Intent detected:", result.intent, result.subIntent ? `(${result.subIntent})` : "", "| Content:", result.content?.substring(0, 30));
      return {
        intent: result.intent || "unknown",
        subIntent: result.subIntent || null,
        content: result.content || userMessage,
      };
    } catch (e) {
      console.error("[ERROR] Failed to parse Claude intent response:", cleanResponse);
      return {
        intent: "unknown",
        subIntent: null,
        content: userMessage,
      };
    }
  } catch (error) {
    console.error("[ERROR] Intent detection failed:", error.message);
    return {
      intent: "unknown",
      content: userMessage,
    };
  }
}

// ========== System Prompts ==========

function buildPrompt(intent, subIntent = null) {
  const baseSystem = `你是 Frank Lin 老師的英文教學助手。

【個性與風格】
- 友善、耐心、鼓勵、專業但親切
- 像一位關心學生進度的英文老師
- 用繁體中文回答，語氣自然不刻板
- 每個回覆都要有鼓勵的語氣

【格式規範 - 絕對重要】
❌ 絕對不要使用 ** 粗體標記
✅ 使用 emoji 標示重點（🔹、💡、✓、❌ 等）
✅ 用分隔線 ━━━━━━━━━━━━━━━━ 區分段落
✅ 適當使用換行和空行
✅ 層級清楚，易於閱讀

【回答原則】
- 解釋清楚但不囉嗦（150-200字為佳）
- 一定要提供實用例句
- 用分隔線和 emoji 讓內容清晰易讀
- 激勵學生繼續學習

【重要提醒】
你不只是知識提供者，而是學生的學習夥伴。回覆時要：
1. 確保學生真正理解了概念
2. 給予具體、可用的例子
3. 在回覆末尾鼓勵學生提出更多問題`;

  const prompts = {
    grammar_explanation: `${baseSystem}

你的任務是回答英文文法問題。使用以下格式回覆：

📚 [文法主題名稱]
━━━━━━━━━━━━━━━━

🔹 結構
[說明該文法的基本結構]

🔹 用法
1️⃣ [用法1] - [詳細說明]
[例句]
2️⃣ [用法2] - [詳細說明]
[例句]
3️⃣ [用法3] - [詳細說明]（如果有）

━━━━━━━━━━━━━━━━
💡 例句
✓ [例句1英文]
（翻譯）
✓ [例句2英文]
（翻譯）
✓ [例句3英文]
（翻譯）

━━━━━━━━━━━━━━━━
🎯 快速記憶法
[簡潔的記憶技巧或口訣]

💪 來試試看吧！
[鼓勵語]

格式要求：
- 清楚解釋該文法規則（繁體中文）
- 舉 2-3 個具體例句（含翻譯）
- 提供記憶技巧
- 最後用 💪 鼓勵
- 簡潔，不超過 500 字`,

    grammar_quiz: `${baseSystem}

你的任務是解析英文選擇題/填空題。使用以下格式回覆：

🎯 正確答案
━━━━━━━━━━━━━━━━
✅ [正確選項]

🔹 為什麼正確
[詳細說明為什麼這個選項是對的]

━━━━━━━━━━━━━━━━
❌ 選項分析

❌ [錯誤選項A]
[為什麼錯]

❌ [錯誤選項B]
[為什麼錯]

❌ [錯誤選項C]（如果有）
[為什麼錯]

━━━━━━━━━━━━━━━━
📖 涉及文法規則

1️⃣ [文法規則1]
[簡短說明]

2️⃣ [文法規則2]（如果有）
[簡短說明]

━━━━━━━━━━━━━━━━
💡 記憶技巧
[幫助記住此規則的技巧或口訣]

💪 下次遇到類似題目就沒問題了！加油！

規則：
- 直接指出正確答案
- 逐一分析每個選項為什麼對或錯
- 清晰說明涉及的文法原理
- 簡潔有力，不超過 500 字`,

    grammar: `${baseSystem}

你的任務是回答英文文法問題。使用以下格式回覆：

📚 [文法主題名稱]
━━━━━━━━━━━━━━━━

🔹 結構
[說明該文法的基本結構]

🔹 用法
1️⃣ [用法1] - [詳細說明]
[例句]
2️⃣ [用法2] - [詳細說明]
[例句]

━━━━━━━━━━━━━━━━
💡 例句
✓ [例句1英文]
（翻譯）
✓ [例句2英文]
（翻譯）
✓ [例句3英文]
（翻譯）

━━━━━━━━━━━━━━━━
🎯 快速記憶法
[簡潔的記憶技巧或口訣]

💪 來試試看吧！

- 清楚解釋該文法規則（繁體中文）
- 舉 2-3 個具體例句（含翻譯）
- 提供記憶技巧
- 最後用 💪 鼓勵
- 簡潔，不超過 500 字`,

    vocabulary_meaning: `你是英語老師。回覆單字查詢時，必須完全按照以下範例格式回覆，每一個空行、每一個符號、每一個換行都要一樣。不可有任何偏差。

📖 apple
━━━━━━━━━━━━━━━━
🔹 發音
/ˈæp(ə)l/

🔹 詞性與意思
名詞 (n.) - 蘋果（水果）；蘋果公司

━━━━━━━━━━━━━━━━
💡 例句
✓ I eat an apple every day for my health.
(我每天吃一個蘋果來保持健康。)

✓ The apple tree in our garden is very old.
(我們花園裡的蘋果樹很老了。)

✓ She works for Apple, one of the biggest tech companies.
(她在蘋果公司工作，那是最大的科技公司之一。)

━━━━━━━━━━━━━━━━
📝 延伸學習
形容詞：apple-red（蘋果紅色的）
相關詞：fruit（水果）、tree（樹）

💪 堅持學習英文，每個單字都會讓你更強大！
試著在日記中用用看吧！✨

必須遵守：
✓ 第1行：📖 + 空格 + 單字
✓ 第2行：分隔線 ━━━━━━━━━━━━━━━━
✓ 第3行：🔹 發音
✓ 第4行：/音標/
✓ 第5行：空行
✓ 第6行：🔹 詞性與意思
✓ 第7行：詞性 - 意思1；意思2
✓ 第8行：空行
✓ 第9行：分隔線
✓ 第10行：💡 例句
✓ 第11行：✓ 例句1英文
✓ 第12行：(中文翻譯)
✓ 第13行：空行
✓ 第14行：✓ 例句2英文
✓ 第15行：(中文翻譯)
✓ 第16行：空行
✓ 第17行：✓ 例句3英文
✓ 第18行：(中文翻譯)
✓ 第19行：空行
✓ 第20行：分隔線
✓ 第21行：📝 延伸學習
✓ 第22行：相關詞彙說明
✓ 第23行：空行
✓ 第24行：鼓勵語 + emoji

絕對禁止：
❌ 删除任何空行或分隔線
❌ 改變任何符號或 emoji
❌ 例句前没有 ✓
❌ 发音没有 / /
❌ 使用 markdown **粗體** 或 *斜體*
❌ 改變 emoji 順序或類型
❌ 在分隔線位置添加或移除空行`,

    vocabulary_pronunciation: `${baseSystem}

你的任務是提供單字的發音指導。使用以下格式回覆：

🔊 [單字]
━━━━━━━━━━━━━━━━
🔹 IPA 音標
[音標]

🔹 英式發音
[詳細描述]

🔹 美式發音
[詳細描述]（如果不同）

━━━━━━━━━━━━━━━━
💡 發音技巧
1️⃣ [技巧1]
2️⃣ [技巧2]

🎯 類似發音的詞
[相似發音詞彙範例]

━━━━━━━━━━━━━━━━
💪 聽不清楚？試試分音節練習！
[練習建議]

- 詳細的發音描述
- 美英發音差異（如果有）
- 實用的練習建議`,

    vocabulary_synonym: `${baseSystem}

你的任務是提供單字的同義詞。使用以下格式回覆：

🔄 [單字] 的同義詞
━━━━━━━━━━━━━━━━
🔹 同義詞列表

1️⃣ [同義詞1]
[細微差別和使用時機]

2️⃣ [同義詞2]
[細微差別和使用時機]

3️⃣ [同義詞3]（如果有）
[細微差別和使用時機]

━━━━━━━━━━━━━━━━
💡 例句對比

✓ He is a wise person.
✓ He is a prudent person.

━━━━━━━━━━━━━━━━
🎯 選詞小技巧
[實用建議]

💪 試試看造句，感受這些詞的差別吧！

- 列出 2-3 個最常用的同義詞
- 清楚解釋使用時機的差別
- 提供對比例句`,

    vocabulary_antonym: `${baseSystem}

你的任務是提供單字的反義詞。使用以下格式回覆：

🔄 [單字] 的反義詞
━━━━━━━━━━━━━━━━
🔹 反義詞列表

1️⃣ [反義詞1]
[詳細說明]

2️⃣ [反義詞2]
[詳細說明]

3️⃣ [反義詞3]（如果有）
[詳細說明]

━━━━━━━━━━━━━━━━
💡 例句對比

原句：✓ This movie is interesting.
反義：✓ This movie is boring.

📝 相關詞彙
[其他相關詞彙]

━━━━━━━━━━━━━━━━
🎯 反義詞小貼士
[實用提示]

💪 試試看用這些反義詞造句吧！

- 列出 2-3 個最常見的反義詞
- 說明在什麼情況下使用
- 提供實際例句`,

    vocabulary_example: `${baseSystem}

你的任務是提供單字的用法例句。使用以下格式回覆：

📝 用 [單字] 造句
━━━━━━━━━━━━━━━━
🔹 基礎例句

✓ [例句1]
✓ [例句2]

🔹 進階例句

✓ [例句3 - 較複雜]
✓ [例句4 - 較複雜]

━━━━━━━━━━━━━━━━
💡 短語搭配

[單字] + [介詞/詞彙]
✓ 例句

[單字] + [詞彙]
✓ 例句

━━━━━━━━━━━━━━━━
⚠️ 常見錯誤

❌ [常見錯用]
✅ [正確用法]

🎯 使用技巧
[實用建議]

━━━━━━━━━━━━━━━━
💪 試試看造幾個句子吧！加油！

- 提供 3-4 個實用例句
- 涵蓋基礎和進階用法
- 列出常見錯誤`,

    vocabulary: `${baseSystem}

你的任務是提供單字查詢。使用以下格式回覆：

📖 [單字]
━━━━━━━━━━━━━━━━
🔹 發音
[IPA 音標]

🔹 詞性與意思
(詞性) [中文意思1]
(詞性) [中文意思2]

━━━━━━━━━━━━━━━━
💡 例句

✓ [例句1英文]
✓ [例句2英文]
✓ [例句3英文]

━━━━━━━━━━━━━━━━
想看更多例句或用法嗎？試試看查詢同義詞或反義詞吧！💪

- 音標（IPA 格式）
- 標記詞性（v. / n. / adj. 等）
- 提供 2-3 個中文意思
- 3 個英文例句
- 結尾用 💪 鼓勵`,

    translation: `${baseSystem}

你的任務是提供準確的英中或中英翻譯。使用以下格式回覆：

🔄 翻譯結果
━━━━━━━━━━━━━━━━
🔹 原文
[原始文本]

🔹 翻譯
[翻譯結果]

━━━━━━━━━━━━━━━━
💡 詞彙說明

[關鍵詞1]：[詳細說明]
[關鍵詞2]：[詳細說明]

━━━━━━━━━━━━━━━━
✨ 其他翻譯選項

✓ [替代翻譯1]
✓ [替代翻譯2]（如果有）

🎯 翻譯小貼士
[實用說明]

━━━━━━━━━━━━━━━━
💪 希望這個翻譯有幫助！

規則：
- 準確翻譯，保留原意
- 標記出特別難翻譯的部分
- 提供 1-2 個替代翻譯
- 簡潔清晰
- 不超過 400 字`,

    error_correction: `${baseSystem}

你的任務是糾正和解釋英文句子錯誤。使用以下格式回覆：

✏️ 句子糾錯
━━━━━━━━━━━━━━━━
❌ 原句
[原句]

✓ 正確
[正確句子]

━━━━━━━━━━━━━━━━
🔹 錯誤說明
[清晰說明錯誤在哪裡、為什麼錯]

🔹 文法重點
[相關的文法規則說明]

━━━━━━━━━━━━━━━━
💡 更多例句
✓ [類似句子1 - 正確]
（說明該用法）
✓ [類似句子2 - 正確]
（說明該用法）

━━━━━━━━━━━━━━━━
💪 練習建議
[鼓勵和建議]

格式要求：
- 清楚識別所有文法、拼寫或用法錯誤
- 提供正確版本
- 解釋為什麼是錯的
- 提供更多例句幫助理解
- 結尾用 💪 鼓勵`,

    essay_review_review: `${baseSystem}

你的任務是批改英文寫作。使用以下格式回覆：

📝 作文批改
━━━━━━━━━━━━━━━━
👍 優點

[列出 2-3 個優點]

━━━━━━━━━━━━━━━━
✨ 建議改進

1️⃣ 文法部分
[錯誤位置]："[錯誤]"
應改為："[正確]"
（說明原因）

2️⃣ 用詞建議
"[原詞]" 可以改用更精確的詞
→ [建議詞匯]

3️⃣ 句子連貫性
[建議]
→ [改進方式]

━━━━━━━━━━━━━━━━
🎯 修改後參考
[提供修改後的參考段落或句子]

━━━━━━━━━━━━━━━━
💪 整體評價
[寫得很棒的評語]
[稍微調整的地方]
[鼓勵和下一步建議]✨

格式要求：
- 整體評語（優點、主要改進方向）
- 結構分析（邏輯、段落組織）
- 列出 2-3 個最重要的錯誤和改進建議
- 提供修改後的參考內容
- 用 emoji 表示不同段落，無粗體
- 鼓勵為主，批評為輔`,

    essay_review_example: `${baseSystem}

你的任務是提供英文寫作範例或範本。根據用戶要求，提供一個專業、實用的範例。使用以下格式回覆：

📋 [文件類型] 範例
━━━━━━━━━━━━━━━━
🔹 範例文本

[完整的範例內容]

━━━━━━━━━━━━━━━━
💡 關鍵要點

✓ [要點1] - [解釋]
✓ [要點2] - [解釋]
✓ [要點3] - [解釋]

📝 可用短語

[常用短語1]
[常用短語2]
[常用短語3]

━━━━━━━━━━━━━━━━
⚠️ 注意事項

[常見錯誤或注意事項1]
[常見錯誤或注意事項2]

🎯 實用建議
[延伸應用或寫作建議]

━━━━━━━━━━━━━━━━
💪 試試用這個範例寫出你自己的作品吧！

規則：
- 提供完整、可直接參考的範例
- 標記出關鍵的表達方式
- 列出可套用的短語和句型
- 簡潔明確，不超過 600 字`,

    essay_review: `${baseSystem}

你的任務是批改英文寫作。使用以下格式回覆：

📝 作文批改
━━━━━━━━━━━━━━━━
👍 優點

[列出 2-3 個優點]

━━━━━━━━━━━━━━━━
✨ 建議改進

1️⃣ 文法部分
[錯誤位置]："[錯誤]"
應改為："[正確]"
（說明原因）

2️⃣ 用詞建議
"[原詞]" 可以改用更精確的詞
→ [建議詞匯]

━━━━━━━━━━━━━━━━
⭐ 整體評分
文法：⭐⭐⭐ (3/5)
詞彙：⭐⭐⭐ (3/5)
結構：⭐⭐⭐⭐ (4/5)

━━━━━━━━━━━━━━━━
💪 整體評價
[寫得很棒的評語]
[稍微調整的地方]
[鼓勵和下一步建議]✨

- 整體評語（優點、主要改進方向）
- 結構分析（邏輯、段落組織）
- 列出 2-3 個最重要的錯誤
- 具體改進建議
- 用星星標記（⭐）評分`,
  };

  // 如果有 subIntent，根據 intent 和 subIntent 選擇相應的 prompt
  if (subIntent) {
    // vocabulary 或 essay_review 有 subIntent
    const subKey = `${intent}_${subIntent}`;
    if (prompts[subKey]) {
      return prompts[subKey];
    }
  }

  return prompts[intent] || baseSystem;
}

// ========== 智能回覆系統 ==========

/**
 * 根據用戶消息類型生成個性化的智能回覆
 * @param {string} userMessage - 用戶的消息
 * @returns {string} - 智能回覆消息
 */
function generateSmartResponse(userMessage) {
  // 檢測問候
  const greetingPattern = /^(hi|hello|你好|嗨|早安|晚安|早|晚|哈|嗨|hi there)/i;
  if (greetingPattern.test(userMessage.trim())) {
    return `嗨！我是 Frank Lin 老師的英文學習助手 😊

我可以幫你：

📚 文法問答
例：is 和 are 的差別？

📖 單字查詢
例：單字: serendipity

✏️ 句子糾錯
例：糾錯: I go to school yesterday

📝 作文批改
例：批改: [貼上英文段落]

🌐 句子翻譯
例：翻譯: How are you?

有任何英文問題都可以問我！💪`;
  }

  // 檢測是否涉及英文學習相關主題
  const englishKeywords = /英文|文法|單字|單词|詞彙|翻譯|句子|作文|文章|發音|例句|糾正|改正|寫作|批改|grammar|word|sentence|essay|writing|pronunciation/i;
  const hasEnglishKeyword = englishKeywords.test(userMessage);

  // 如果不涉及英文學習，回覆不相關問題
  if (!hasEnglishKeyword) {
    return `抱歉，我是專門的英文學習助手。😅
這個問題不在我的專業範圍內。

不過，如果你有英文學習的問題，我很樂意幫忙！✨

你可以試試：

📚 文法問答
📖 單字查詢
✏️ 句子糾錯
📝 作文批改
🌐 句子翻譯

來問我英文問題吧！💪`;
  }

  // 默認：模糊問題回覆
  return `你想學英文的哪個部分呢？🤔

我可以幫你：

📚 文法解析
例：什麼是現在完成式？

📖 單字查詢
例：單字: accommodate

✏️ 句子糾錯
例：糾錯: She don't like apples

📝 作文批改
直接貼上你的英文段落

🌐 句子翻譯
例：翻譯: I love learning English

試試看問我一個具體的問題吧！😊`;
}

// ========== 回覆選單 ==========

function getHelpMessage() {
  return `嗨！我是 Frank Lin 老師的英文學習助手 😊

我可以幫你：

📚 文法問答
例：is 和 are 的差別？

📖 單字查詢
例：單字: serendipity

✏️ 句子糾錯
例：糾錯: I go to school yesterday

📝 作文批改
例：批改: [貼上英文段落]

🌐 句子翻譯
例：翻譯: How are you?

有任何英文問題都可以問我！💪`;
}

// ========== 行事曆 Bot 功能 ==========

/**
 * 推送 LINE 訊息（主動推送，無需 replyToken）
 * @param {string} to - 用戶 ID、群組 ID 或房間 ID
 * @param {object} message - 訊息物件
 * @param {string} token - LINE Channel Access Token
 * @returns {Promise}
 */
async function pushLineMessage(to, message, token) {
  return new Promise((resolve, reject) => {
    if (!token) {
      console.error("[ERROR] LINE token not provided");
      return reject(new Error("LINE token is required"));
    }

    const data = JSON.stringify({
      to: to,
      messages: [message]
    });

    const options = {
      hostname: "api.line.me",
      port: 443,
      path: "/v2/bot/message/push",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data, 'utf8'),
        "Authorization": `Bearer ${token}`
      }
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("[INFO] Push message sent successfully");
          resolve(responseData);
        } else {
          console.error(`[ERROR] Failed to push: ${res.statusCode}`, responseData);
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on("error", (error) => {
      console.error("[ERROR] HTTP request error:", error.message);
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

/**
 * 從 Google Calendar iCal URL 取得事件
 * @param {string} icalUrl - iCal 公開連結
 * @returns {Promise<Array>} 事件陣列
 */
async function fetchCalendarEvents(icalUrl) {
  try {
    if (!icalUrl) {
      console.warn("[WARN] GOOGLE_CALENDAR_ICAL_URL not set");
      return [];
    }

    const ical = require("node-ical");
    const events = await ical.async.fromURL(icalUrl);

    const result = [];
    for (const key in events) {
      const event = events[key];
      if (event.type === "VEVENT") {
        result.push({
          id: event.uid || key,
          title: event.summary || "無標題",
          start: new Date(event.start),
          end: new Date(event.end),
          location: event.location || "",
          description: event.description || ""
        });
      }
    }

    return result.sort((a, b) => a.start - b.start);
  } catch (error) {
    console.error("[ERROR] Failed to fetch calendar events:", error.message);
    return [];
  }
}

/**
 * 檢測行事曆相關的用戶意圖（中文關鍵字）
 * @param {string} text - 用戶訊息
 * @returns {string} 意圖：today | tomorrow | week | next | unknown
 */
function detectCalendarIntent(text) {
  if (/今日|今天/.test(text)) return "today";
  if (/明日|明天/.test(text)) return "tomorrow";
  if (/本週|這週|本周|這周/.test(text)) return "week";
  if (/下一個|下個|最近|下一|接下來/.test(text)) return "next";
  return "unknown";
}

/**
 * 格式化行事曆事件為 LINE 訊息
 * @param {Array} events - 事件陣列
 * @param {string} label - 標籤（例如「今日」「明日」）
 * @returns {string} 格式化後的訊息
 */
function formatCalendarEvents(events, label) {
  if (!events || events.length === 0) {
    return `📅 ${label}\n\n${label}沒有行程 😊`;
  }

  let message = `📅 ${label}行程\n`;

  for (const evt of events) {
    const startStr = evt.start.toLocaleDateString("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    });
    const startTime = evt.start.toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit"
    });
    const endTime = evt.end.toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit"
    });

    message += `\n📌 ${evt.title}`;
    message += `\n🕐 ${startStr} ${startTime} - ${endTime}`;

    if (evt.location) {
      message += `\n📍 ${evt.location}`;
    }

    if (evt.description) {
      message += `\n📝 ${evt.description}`;
    }

    message += `\n──────────`;
  }

  return message;
}

/**
 * 處理行事曆相關訊息（Ivy's English Bot）
 * @param {string} userMessage - 用戶訊息
 * @param {string} replyToken - 回覆令牌
 * @param {string} token - LINE Channel Access Token
 */
async function handleCalendarMessage(userMessage, replyToken, token) {
  try {
    const intent = detectCalendarIntent(userMessage);
    const events = await fetchCalendarEvents(process.env.GOOGLE_CALENDAR_ICAL_URL);

    let relevantEvents = [];
    let label = "";

    if (intent === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      relevantEvents = events.filter(e => e.start >= today && e.start < tomorrow);
      label = "今日";
    } else if (intent === "tomorrow") {
      const tomorrow = new Date();
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dayAfter = new Date(tomorrow);
      dayAfter.setDate(dayAfter.getDate() + 1);

      relevantEvents = events.filter(e => e.start >= tomorrow && e.start < dayAfter);
      label = "明日";
    } else if (intent === "week") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const day = today.getDay();
      const diff = today.getDate() - day;
      const weekStart = new Date(today.setDate(diff));
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      relevantEvents = events.filter(e => e.start >= weekStart && e.start < weekEnd);
      label = "本週";
    } else if (intent === "next") {
      const now = new Date();
      relevantEvents = events.filter(e => e.start > now);
      if (relevantEvents.length > 0) {
        relevantEvents = [relevantEvents[0]];
      }
      label = "下一個活動";
    } else {
      const helpMessage = `🎯 Ivy's English 行事曆助手

使用方式：
✅ 傳「今日行程」或「今天」→ 查詢今日行程
✅ 傳「明日行程」或「明天」→ 查詢明日行程
✅ 傳「本週行程」或「這週」→ 查詢本週行程
✅ 傳「下一個活動」→ 查詢最近即將開始的活動

🔔 每天早上 8:00 自動推送隔日行程提醒`;

      await replyLineMessage(replyToken, {
        type: "text",
        text: helpMessage
      }, token);
      return;
    }

    const formattedMessage = formatCalendarEvents(relevantEvents, label);
    await replyLineMessage(replyToken, {
      type: "text",
      text: formattedMessage
    }, token);
  } catch (error) {
    console.error("[ERROR] Calendar message handling failed:", error.message);
    await replyLineMessage(replyToken, {
      type: "text",
      text: "抱歉，無法取得行程資訊。請稍後重試。"
    }, token);
  }
}

// ========== 主要流程 ==========

/**
 * 處理訊息文本
 * @param {string} userMessage - 用戶訊息
 * @param {string} replyToken - 回覆令牌
 * @param {string} token - LINE Channel Access Token（可選，如果未提供則使用預設）
 */
async function handleTextMessage(userMessage, replyToken, token) {
  try {
    // 用 Claude 智能偵測意圖
    const intentData = await detectIntentWithClaude(userMessage);
    const intent = intentData.intent;
    const subIntent = intentData.subIntent;
    const content = intentData.content;

    if (intent === "unknown") {
      const smartResponse = generateSmartResponse(userMessage);
      await replyLineMessage(replyToken, {
        type: "text",
        text: sanitizeTextForLine(smartResponse),
      }, token);
      return;
    }

    if (!content || content.trim().length === 0) {
      await replyLineMessage(replyToken, {
        type: "text",
        text: sanitizeTextForLine(`❌ 請提供完整的問題\n\n${getHelpMessage()}`),
      }, token);
      return;
    }

    // 快取查詢（包含 subIntent 以區分不同的查詢類型）
    const cacheKeyInput = subIntent ? `${intent}:${subIntent}:${content}` : `${intent}:${content}`;
    const cacheKey = crypto.createHash("md5").update(cacheKeyInput).digest("hex");
    let response = await getCachedResponse(cacheKey);

    if (response) {
      await replyLineMessage(replyToken, {
        type: "text",
        text: response,
      }, token);
      return;
    }

    // 呼叫 Claude
    console.log("[INFO] Cache miss, calling Claude API...");
    const systemPrompt = buildPrompt(intent, subIntent);
    const maxTokens = intent === "essay_review" ? 2048 : 1024;

    response = await callClaude(systemPrompt, content, maxTokens);

    // 存入快取
    await setCachedResponse(cacheKey, response);

    // 回覆（清理文本以符合 LINE API 要求）
    await replyLineMessage(replyToken, {
      type: "text",
      text: sanitizeTextForLine(response),
    }, token);
    console.log("[INFO] Message replied successfully");
  } catch (error) {
    console.error("[ERROR] Error handling message:", error);
    try {
      await replyLineMessage(replyToken, {
        type: "text",
        text: sanitizeTextForLine(`❌ 發生錯誤，請稍後再試\n\nError: ${error.message}`),
      }, token);
    } catch (replyError) {
      console.error("[ERROR] Failed to send error reply:", replyError.message);
    }
  }
}

// ========== LINE Webhook ==========

/**
 * 驗證 LINE webhook 簽章
 * @param {object} req - Express 請求物件
 * @param {string} secret - LINE Channel Secret（用於驗證簽章）
 * @returns {boolean} - 簽章是否有效
 */
function verifyLineSignature(req, secret) {
  try {
    const signature = req.headers["x-line-signature"];
    if (!signature) {
      console.log("[WARN] No signature header");
      return false;
    }

    // LINE 簽章驗證必須使用原始 request body (rawBody)，轉換為字符串
    let body = req.rawBody;
    if (!body) {
      console.error("[ERROR] Raw body not available");
      return false;
    }

    // 如果 body 是 Buffer，轉換為字符串
    if (Buffer.isBuffer(body)) {
      body = body.toString("utf8");
    }

    // 計算簽章（使用 SHA256）
    const hash = crypto
      .createHmac("SHA256", secret)
      .update(body)
      .digest("base64");

    const verified = hash === signature;
    if (!verified) {
      console.log("[WARN] Signature verification failed for secret:", secret.substring(0, 8) + "...");
    }

    return verified;
  } catch (error) {
    console.error("[ERROR] Signature verification error:", error.message);
    return false;
  }
}

// 定義 Express 路由 handler
app.post("/", async (req, res) => {
  try {
    // 只接受 POST
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    // 識別 Bot（通過 destination 或 X-Line-Webhook-Middleware 頭部）
    const destination = req.body.destination;
    if (!destination) {
      console.error("[ERROR] Missing destination field");
      return res.status(400).send("Missing destination");
    }

    // 獲取該 Bot 的配置
    const botConfig = BOT_CONFIG[destination];
    if (!botConfig) {
      console.error("[ERROR] Unknown bot destination:", destination);
      return res.status(400).send("Unknown bot");
    }

    console.log(`[INFO] Processing webhook for: ${botConfig.name} (${destination})`);

    // Load credentials from environment variables
    let botCredentials;
    try {
      botCredentials = getBotCredentials(botConfig);
    } catch (error) {
      console.error("[ERROR] Failed to load bot credentials:", error.message);
      return res.status(500).send("Credentials not configured");
    }

    // 使用對應的 secret 驗證簽章
    if (!verifyLineSignature(req, botCredentials.secret)) {
      return res.status(403).send("Signature verification failed");
    }

    // 取得 events
    const events = req.body.events || [];

    // LINE 驗證請求：events 為 空，直接返回 200
    if (events.length === 0) {
      return res.status(200).send("OK");
    }

    // 有實際事件才處理
    console.log("[INFO] Processing", events.length, "event(s)");

    for (const event of events) {
      // 處理訊息事件
      if (event.type === "message" && event.message.type === "text") {
        const sourceType = event.source.type;
        const userMessage = event.message.text;

        // 檢查是否為群組或多人聊天
        const isGroupChat = sourceType === "group" || sourceType === "room";

        if (isGroupChat) {
          // 在群組中，檢查是否被提及
          // 檢查訊息是否回覆了 Bot 的訊息（replyToken 會在回覆時設置）
          const isBotMentioned = userMessage.includes("@") ||
                                 (event.message.mention &&
                                  event.message.mention.mentionees &&
                                  event.message.mention.mentionees.some(m => m.type === "user"));

          // 如果沒有被提及，忽略訊息
          if (!isBotMentioned) {
            console.log("[INFO] Group message without mention, skipping");
            continue;
          }

          console.log("[INFO] Bot was mentioned in group, processing message");
        }

        // 處理訊息（一對一 或 群組中被提及的訊息）
        // 根據 Bot 角色分流
        if (botConfig.role === "calendar") {
          await handleCalendarMessage(userMessage, event.replyToken, botCredentials.token);
        } else {
          await handleTextMessage(userMessage, event.replyToken, botCredentials.token);
        }
      }
      // 處理 join 事件（Bot 被加入群組）
      else if (event.type === "join") {
        try {
          const sourceType = event.source.type;
          const sourceId = event.source.groupId || event.source.roomId;

          // 使用該 Bot 配置中的欢迎消息
          const joinMessage = botConfig.joinMessage;

          await replyLineMessage(event.replyToken, {
            type: "text",
            text: sanitizeTextForLine(joinMessage),
          }, botCredentials.token);

          console.log(`[INFO] ${botConfig.name} joined ${sourceType}, sent welcome message`);
        } catch (error) {
          console.error("[ERROR] Failed to send join message:", error.message);
        }
      }
    }

    console.log("[INFO] All events processed successfully");
    res.status(200).json({success: true});
  } catch (error) {
    console.error("[ERROR] Webhook error:", error.message);
    res.status(500).json({error: error.message});
  }
});

// ========== 行事曆定時提醒 (Cloud Scheduler) ==========

const {onSchedule} = require("firebase-functions/v2/scheduler");

/**
 * 每天早上 8:00 檢查並推送隔日行程提醒
 */
exports.calendarReminder = onSchedule("0 8 * * *", async (event) => {
  try {
    console.log("[INFO] Calendar reminder job started");

    // 1. 讀取環境變數
    const icalUrl = process.env.GOOGLE_CALENDAR_ICAL_URL;
    const groupIds = (process.env.CALENDAR_NOTIFY_GROUP_ID || "").split(",").filter(id => id.trim());
    const token = getCredential("LINE_CHANNEL_ACCESS_TOKEN_BOT2");

    if (groupIds.length === 0) {
      console.warn("[WARN] CALENDAR_NOTIFY_GROUP_ID not set");
      return;
    }

    // 2. 取得行事曆事件
    const events = await fetchCalendarEvents(icalUrl);
    console.log(`[INFO] Fetched ${events.length} calendar events`);

    // 3. 篩選「明天」的事件（活動前 1 天）
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    const tomorrowEvents = events.filter(e => e.start >= tomorrow && e.start < dayAfter);
    console.log(`[INFO] Found ${tomorrowEvents.length} events for tomorrow`);

    if (tomorrowEvents.length === 0) {
      console.log("[INFO] No events tomorrow, skipping notification");
      return;
    }

    // 4. 初始化 Firebase
    initializeFirebase();

    // 5. 逐一檢查和推送通知
    for (const evt of tomorrowEvents) {
      const sentRef = dbRef.ref(`/calendar-sent/${evt.id}`);
      const snap = await sentRef.get();

      if (snap.exists()) {
        console.log(`[INFO] Event "${evt.title}" already sent, skipping`);
        continue;
      }

      // 推送到所有配置的群組
      const message = formatCalendarEvents([evt], "明日");
      for (const gid of groupIds) {
        try {
          await pushLineMessage(gid.trim(), { type: "text", text: message }, token);
          console.log(`[INFO] Sent notification for "${evt.title}" to group ${gid}`);
        } catch (pushError) {
          console.error(`[ERROR] Failed to push to ${gid}:`, pushError.message);
        }
      }

      // 記錄已發送
      await sentRef.set({
        sentAt: Date.now(),
        eventTitle: evt.title,
        eventStart: evt.start.toISOString()
      });
    }

    console.log("[INFO] Calendar reminder job completed successfully");
  } catch (error) {
    console.error("[ERROR] Calendar reminder job failed:", error.message);
  }
});

// 導出 Express app 作為 Firebase Function
exports.lineWebhook = onRequest(app);
