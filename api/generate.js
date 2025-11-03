// Vercel Serverless Function: /api/generate

/**
 * AI PC 規格生成器的後端處理函數。
 * 接收用戶需求和硬體參考數據，呼叫 Gemini API 進行結構化 JSON 輸出。
 */

// 嚴格定義 Gemini 模型需要輸出的 JSON 結構 (JSON Schema)
const responseSchema = {
    type: "ARRAY",
    items: {
        type: "OBJECT",
        properties: {
            "componentName": {
                "type": "STRING",
                "description": "電腦組件的名稱和簡寫（例如：處理器(CPU), 顯示卡(GPU)）。"
            },
            "componentDescription": {
                "type": "STRING",
                "description": "根據用戶需求推薦的具體型號、規格和簡短的推薦理由，並確保所有組件之間是完全相容的。"
            }
        },
        required: ["componentName", "componentDescription"],
        propertyOrdering: ["componentName", "componentDescription"]
    }
};

// Vercel 函數的入口點
export default async function handler(req, res) {
    // 1. 確保只處理 POST 請求
    if (req.method !== 'POST') {
        res.status(405).json({ message: 'Method Not Allowed, please use POST.' });
        return;
    }

    // 🚨 關鍵修正：從 Vercel 環境變數中讀取 API Key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        // 如果 Key 不存在，立即返回 500 錯誤
        console.error("[CRITICAL] GEMINI_API_KEY environment variable is not set on Vercel.");
        return res.status(500).json({ 
            message: '伺服器配置錯誤：未找到 API 金鑰。請檢查 Vercel 環境變數 GEMINI_API_KEY 是否已設定。',
            errorCode: 'NO_API_KEY_CONFIGURED'
        });
    }

    // 構建 API URL
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    let prompt, hardwareData;
    try {
        // 嘗試從請求體中解析數據
        ({ prompt, hardwareData } = req.body);
    } catch (error) {
        return res.status(400).json({ message: 'Invalid JSON body or missing prompt/hardwareData.' });
    }

    if (!prompt) {
        return res.status(400).json({ message: 'Prompt is required.' });
    }

    // 2. 組合 System Instruction 和 User Query
    const systemPrompt = `你是一位專業的 AI PC 組裝顧問。你的任務是根據用戶的需求 (${prompt})，從提供的硬體規格參考圖表 (如下方) 中，挑選出最適合的電腦組件，並以 JSON 格式輸出。

1. 請務必輸出 8 個主要組件：主機板、處理器、散熱器、記憶體、顯示卡、儲存裝置、電源供應器、機殼。
2. componentName 必須是組件的中文名稱和簡寫（例如：處理器(CPU)）。
3. componentDescription 必須包含具體的型號、規格和簡短的推薦理由，並確保所有組件之間是完全相容的（例如：CPU 與 MB 的腳位/晶片組、MB 與 RAM 的世代）。
4. 你必須嚴格遵循提供的 JSON Schema，並只輸出 JSON 內容，不包含任何額外的文字或 Markdown 標記。
5. 提供的硬體數據是參考資料，你應根據這些信息進行合理的硬體搭配。`;

    const userQuery = `用戶需求: ${prompt}\n\n硬體規格參考圖表:\n${hardwareData}`;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema
        }
    };

    // 3. 執行 API 呼叫 (帶有指數退避重試邏輯)
    const MAX_RETRIES = 5;
    let apiResponse = null;
    let lastError = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                // 如果 API 返回 403, 400, 429, 5xx 錯誤，檢查具體原因
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData.error?.message || response.statusText;
                
                if (response.status === 403 || response.status === 400) {
                    // 403 Forbidden 或 400 Bad Request 通常表示 Key 無效、未啟用或配額不足
                    throw new Error(`Gemini API Failed (Status: ${response.status}). Check Key validity, Billing, and API Enablement. Message: ${errorMessage}`);
                }
                
                // 對於可重試錯誤（如 429 或 5xx），進行重試
                if (response.status === 429 || response.status >= 500) {
                    throw new Error(`API returned status ${response.status}. Retrying... Message: ${errorMessage}`);
                }

                // 其他非重試錯誤
                throw new Error(`API returned unhandled status ${response.status}. Message: ${errorMessage}`);
            }

            apiResponse = await response.json();
            break; // 成功，跳出循環

        } catch (error) {
            lastError = error;
            if (i < MAX_RETRIES - 1) {
                const delay = Math.pow(2, i) * 1000; // 指數退避: 1s, 2s, 4s, ...
                console.warn(`[Retry ${i + 1}] API call failed: ${error.message}. Delaying ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error("Gemini API call failed after max retries:", lastError.message);
                // 最終失敗
                return res.status(500).json({ 
                    message: "無法生成規格清單。Gemini API 呼叫失敗，請檢查 API 金鑰、結帳和配額。",
                    errorDetails: lastError.message 
                });
            }
        }
    }

    // 4. 解析並返回結果
    try {
        const candidate = apiResponse.candidates?.[0];
        const jsonText = candidate.content?.parts?.[0]?.text;

        if (!jsonText) {
            // 如果沒有文本，檢查是否有安全過濾或其他阻止原因
            const finishReason = candidate?.finishReason || 'UNKNOWN';
            const safetyRatings = candidate?.safetyRatings || 'N/A';
            console.error("Gemini returned empty content. Finish Reason:", finishReason, "Safety:", JSON.stringify(safetyRatings));
            throw new Error(`Gemini returned empty content. Finish Reason: ${finishReason}`);
        }

        const parsedJson = JSON.parse(jsonText);
        
        // 成功返回 JSON 陣列給前端
        return res.status(200).json(parsedJson);
        
    } catch (e) {
        console.error("Error parsing or sending final response:", e);
        // 如果解析失敗，返回包含原始 API 回覆的錯誤訊息
        return res.status(500).json({ 
            message: "AI 生成了無效的 JSON 格式，可能因為安全過濾或模型輸齣錯誤。",
            errorDetails: e.message
        });
    }
}
