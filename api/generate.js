/**
 * Vercel Serverless Function: /api/generate
 * 作用: 接收前端傳送的基礎圖片和貼圖情境 (Prompt)，並呼叫 Gemini API 執行圖生圖 (Image-to-Image)
 * 以生成卡通風格的貼圖。
 * 部署路徑: 在 Vercel 專案中，將此檔案放在 'api/' 目錄下。
 * 環境變數: 必須設定 GEMINI_API_KEY。
 */

// 從環境變數中取得 API Key
const API_KEY = process.env.GEMINI_API_KEY || "";
const API_URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * 處理指數退避 (Exponential Backoff) 的 Fetch 函數
 * @param {string} url - 請求 URL
 * @param {object} options - Fetch 選項
 * @param {number} maxRetries - 最大重試次數
 * @returns {Promise<Response>} API 回應
 */
async function fetchWithRetry(url, options, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                // 如果是 429 Too Many Requests 或 5xx 錯誤，嘗試重試
                if (response.status === 429 || response.status >= 500) {
                    throw new Error(`Retriable HTTP error! status: ${response.status}`);
                }
                // 對於其他非 200 狀態碼 (如 400 Bad Request)，直接拋出錯誤
                const errorBody = await response.text();
                throw new Error(`API Request failed with status ${response.status}: ${errorBody}`);
            }
            return response;
        } catch (error) {
            console.error(`Attempt ${attempt + 1} failed: ${error.message}`);
            if (attempt === maxRetries - 1) {
                throw error;
            }
            // 指數退避延遲 (1s, 2s, 4s, 8s, ...)
            const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000); // 增加隨機抖動
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}


/**
 * Serverless 函數主處理器 (Vercel Node.js 格式)
 * @param {object} req - 請求物件
 * @param {object} res - 回應物件
 */
export default async function handler(req, res) {
    // 檢查 API Key 是否存在
    if (!API_KEY) {
        return res.status(500).json({ error: "伺服器配置錯誤：GEMINI_API_KEY 未設定。" });
    }

    // 僅接受 POST 請求
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "僅支援 POST 請求。" });
    }

    try {
        let requestBody = req.body;

        // 【新增的防禦性解析】
        // 如果 req.body 是字串（可能是因為代理解析失敗而傳入 "[object Object]" 或原始 JSON 字串），嘗試手動解析。
        if (typeof req.body === 'string' && req.body.length > 0) {
            try {
                requestBody = JSON.parse(req.body);
            } catch (parseError) {
                console.warn("手動解析請求主體失敗，可能是無效的 JSON 格式:", parseError.message);
                // 如果解析失敗，則讓後續的檢查來處理無效的內容
                requestBody = {}; 
            }
        }
        
        // 從 (已解析的) requestBody 中解構變數
        const { promptText, image, model } = requestBody;

        if (!promptText || !image || !image.data || !image.mimeType || !model) {
            return res.status(400).json({ error: "缺少必要的請求參數 (promptText, image.data, image.mimeType, 或 model)。" });
        }

        const modelName = model; // 前端指定使用 gemini-2.5-flash-image-preview
        const apiUrl = `${API_URL_BASE}/${modelName}:generateContent?key=${API_KEY}`;

        // 構建 API 請求 Payload
        const payload = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: promptText }, // 文字指令
                        {
                            inlineData: {
                                mimeType: image.mimeType,
                                data: image.data // Base64 圖片數據
                            }
                        }
                    ]
                }
            ],
            // 啟用圖片生成模式
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE']
            },
        };

        const response = await fetchWithRetry(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        // 檢查 API 回應結構並提取 Base64 圖片數據
        const base64Data = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

        if (base64Data) {
            // 成功，回傳 Base64 數據給前端
            res.status(200).json({ base64Data: base64Data });
        } else {
            // AI 生成失敗或回應格式不正確
            console.error("Gemini API response structure error or blocked content:", JSON.stringify(result, null, 2));
            const message = result.candidates?.[0]?.safetyRatings?.[0]?.probability === "HIGH" 
                ? "內容可能因安全政策而被阻擋，請嘗試修改情境。" 
                : "AI 生成圖片失敗，請檢查情境或重試。";
                
            res.status(500).json({ 
                error: message,
                details: result
            });
        }

    } catch (e) {
        console.error("處理 API 請求時發生錯誤:", e);
        res.status(500).json({ error: `伺服器內部錯誤: ${e.message}` });
    }
}
