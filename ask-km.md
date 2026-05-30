# Ask KM — 開發問答知識庫

本文件記錄開發過程中問答的重要知識，方便日後查閱。

---

## 2026-05-30

### Q1：「需要確認的句子」功能還在嗎？為什麼 OpenAI 轉錄後看不到？

**A：**
功能仍存在（`lowConfidence` 旗標 + 過濾按鈕），但需要 **`verbose_json` 模式**才能產生標記：

- `verbose_json` 回應內含每個 segment 的 `avg_logprob`（對數概似值）與 `temperature`，程式根據以下條件判斷低信心：
  - `avg_logprob < -0.85`
  - `temperature > 0.6`
- 若模型不支援 `verbose_json`（如 `gpt-4o-mini-transcribe`），系統會 fallback 為 `json` 模式，只回傳純文字，**沒有 segment 信心分數**，故所有句子都不會標記為低信心。

**解法：** 使用支援 `verbose_json` 的模型（如 `whisper-1`、Groq `whisper-large-v3`），低信心句子就會重新出現。

---

### Q2：哪個模型可以識別說話者（Speaker Diarization）？

**A：**
Whisper 原生**不支援**說話者識別，純語音轉文字不帶說話者標籤。

| 方案                               | 特色                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| **AssemblyAI**                     | 原生支援，API 直接返回 `speaker_A / speaker_B` 標籤，最易整合 |
| **Deepgram Nova-2**                | 支援 `diarize=true` 參數，自動標記說話者                      |
| **Pyannote（本地）**               | 開源說話者分離模型，搭配 Whisper 做後處理，需本地執行         |
| **Azure Speech**                   | 支援對話轉錄模式，內建說話者識別                              |
| **Google Cloud Speech-to-Text v2** | 支援 `speaker_diarization_config`                             |
| **GPT-4o Audio**                   | 若 prompt 指定說話者識別，有時能從語意推斷，但**不保證準確**  |

**目前 App 最小改動整合路徑：AssemblyAI 或 Deepgram**（轉錄 API 直接帶說話者標籤）。

---

### Q3：音檔切割為 2 分鐘的原因與最佳長度？

**A：**

| 考量點                           | 說明                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Whisper 解碼器幻覺（最主要）** | Whisper 的 Attention Window 設計以 30 秒為一單元。長音檔含靜音/噪音時，解碼累積誤差自我強化，造成「無限重複同一句話」的幻覺。2 分鐘切片能強行重置 Context。 |
| **API 上傳容量與逾時**           | 多數 API 代理有 25MB 上傳限制；2 分鐘 normalized MP3 通常僅幾百 KB，100% 傳輸成功。                                                                         |
| **容錯重試**                     | 單段失敗只需重試 2 分鐘的切片，不需整場重來。                                                                                                               |

**最佳切割長度黃金比例：1–2 分鐘**

- 30 秒：貼近 Whisper 架構，但 API 請求次數過多、網路開銷大。
- 5 分鐘以上：極靜音/干擾音場合，幻覺發生機率大增。

---

### Q4：版號更新邏輯建議

**用戶原定邏輯：**

1. 不上 git → 增加 `0.0.1`（patch）
2. 上 git & push remote → 增加 `0.1.0`（minor）
3. 正式版 → 增加 `1.0.0`（major）

**評估：非常合理且具敏捷性！**

微調建議：

- 持續使用 `-beta` 等 Pre-release 標記，等穩定再發布 `1.0.0` stable。
- push remote 時搭配 `git tag vX.Y.Z-beta && git push --tags`，GitHub Release 頁面自動長出時間軸。
- **每次對話後，至少 commit 本地 git（已設為預設行為）。**

---

### Q5：本地版本每次自動 commit git 約定

**約定：**

- 每次完成功能後，版號至少 patch 遞增（`0.0.x`），並 `git add -A && git commit`。
- 若本次有功能性變更（新 feature 或大改動），則 minor 遞增（`0.x.0`），並同時 `git push origin main`。
- 無需每次詢問，自動執行。

---

### Q6：送給 OpenAI 的音檔以 2 分鐘切割，逐字稿輸出也是 2 分鐘一大段嗎？

**A：不是。** 逐字稿的段落細粒度由模型回傳的 segments 決定，與送進去的切片長度無關。

| 模式                                                 | 行為                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`verbose_json`**（whisper-1、whisper-large-v3 等） | 每個 2 分鐘切片回傳 **N 個小 segment**（通常每段 2–10 秒）。程式碼將每個 segment 的 `start/end` 加上 `baseOffset`（= 切片編號 × 120 秒）還原為整場絕對時間。最終顯示的是密集小段，**不是 2 分鐘大塊**。 |
| **`json` fallback**（gpt-4o-mini-transcribe 等）     | 只回傳整段純文字，無子 segment。程式將文字切成句子後**平均分配**到那 2 分鐘（`segmentDuration = 120秒 ÷ 句子數`）。時間戳為人工插值，每句時間長度均等，**不反映真實語音節奏**。                         |

**結論：** 2 分鐘切片是為了避免 API 大小限制與 Whisper 幻覺問題，輸出段落粒度由模型 segment 切割決定，與切片長度無關。

---

### Q7：gpt-4o-mini-transcribe 辨識較好但時間戳不準，whisper-1 時間戳準但辨識較差，如何優化？

**根本原因：**
`gpt-4o-mini-transcribe` 不支援 `verbose_json`，程式 fallback 為 `json` 模式，時間戳改以句子數平均插值，與實際語音節奏無關，導致 highlight 對不上音訊。

**優化方案（由易到難）：**

| 方案                                  | 說明                                                                                                                                                                                    | 改動量                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Groq + whisper-large-v3**（最推薦） | Groq 提供 OpenAI 相容 API，支援 `verbose_json`，辨識品質遠優於 whisper-1，速度更快、費用更低。直接在 AI Settings 新增 Groq provider 並選用 `whisper-large-v3`，**不需修改任何程式碼**。 | 零（純設定）            |
| **AssemblyAI / Deepgram**             | 原生提供高品質辨識 + 精準字詞級時間戳，同時支援說話者識別。需新增 provider 整合。                                                                                                       | 中（新 provider class） |
| **兩段式 (Two-pass) 架構**            | 第一次用 whisper-1（verbose_json）取得精準時間戳；第二次用 gpt-4o-mini-transcribe 取得優質文字；再用 diff 對齊把優質文字貼回 whisper 時間戳區間。可行但實作複雜，且 API 費用加倍。      | 高                      |

**建議行動：** 先試 Groq `whisper-large-v3`，若仍有辨識需求（如繁體中文特殊術語），再考慮 AssemblyAI 整合。

---

### Q8：兩段式架構（whisper 取時間戳 + gpt-4o-mini-transcribe 取文字）如何對齊？複雜度如何？

**背景：** Groq whisper-large-v3-turbo 時間戳準但辨識較差（繁體中文術語），gpt-4o-mini-transcribe 辨識好但無時間戳（json fallback 只回純文字）。

**兩段式對齊原理（字符級 LCS diff）：**

```
每個 2 分鐘音檔切片，同時送兩個 API：

Groq whisper (verbose_json)
  → [{start:0, end:3, text:"我想問一下"}, {start:3, end:7, text:"這個功能"}, ...]

gpt-4o-mini-transcribe (json)
  → "我想詢問這個功能的用法..."  （品質較好，但無時間戳）

對齊步驟：
1. 串接 whisper 所有 segment.text → whisperFullText
2. 對 whisperFullText 與 gpt4oText 做字符級 LCS diff（中文無空格，不能用詞級）
3. 根據 diff 結果，找出每個 gpt-4o-mini 字符在 whisper 中的對應位置
4. 反推對應 segment 的時間戳，重新切分 gpt-4o-mini 文字輸出
```

**複雜度評估：**

| 層面     | 說明                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| API 呼叫 | 每個切片送兩次，費用與延遲加倍                                                    |
| 程式碼量 | 新增 ~150 行對齊邏輯 + 修改 provider 架構支援 dual-model                          |
| 可靠性   | ~75–80%。兩模型輸出差異小（同音字、標點）時對齊準；差異大（整句改寫）時時間戳錯位 |
| 中文難點 | 無詞邊界；兩模型可能用不同字（「哪」vs「那」、「的」vs「得」），LCS 有誤判風險    |
| 結論     | 可行，但需要先確認兩模型輸出差異程度（若超過 30% 字符不同，對齊品質低，不值得做） |

---

### Q9：【程式碼發現】Glossary 只做事後替換，未注入 Whisper prompt，這是高 ROI 的快速優化

**發現（來自程式碼閱讀）：**

- `src/main/openai-provider.ts` 的 `buildTranscriptionPrompt()` 只傳入 `outputLanguage` 和 `identifySpeakers`，**完全未使用 Glossary 詞彙**。
- `src/main/index.ts` 中，Glossary 的使用時機是轉錄完成**之後**，做 `applyGlossary()` 文字替換。

```typescript
// 目前的流程：
const transcript = await txProvider.transcribeAudio(chunkPaths)
// ↑ Glossary 完全不影響辨識過程

// 轉錄後才做文字替換：
transcript.text = applyGlossary(transcript.text, glossary)
```

**問題：** Whisper 若辨識錯誤（例如把「消金」聽成「小金」），事後替換才能修正；但如果把 Glossary 詞彙加入 `prompt`，Whisper 在辨識時就會優先使用這些詞，**從源頭提高準確率**。

**Whisper prompt 的作用：**

> Whisper 的 `prompt` 參數是一段「前一段對話提示」，模型會傾向延續 prompt 中出現過的詞彙。把專有名詞放進去，等同於告訴模型「這場對話會用到這些詞」。

**建議優化（改動約 10 行）：**

1. 在 `createAIProvider` 前取得 Glossary 資料
2. 傳入 provider config
3. 在 `buildTranscriptionPrompt()` 末尾附加詞彙列表

這是優先於兩段式架構的改善方案，**成本低、風險零、ROI 高**，建議先實作此項再評估是否仍需兩段式。

---

### Q10：程式目前有針對不同模型做不同處理嗎？

**A：沒有。** 所有模型走同一條路：先試 `verbose_json` → 失敗就 fallback `json`。`transcriptionModel` 只是傳給 API 的字串，程式碼不做任何模型分支。

```typescript
// openai-provider.ts — 唯一的分支邏輯是 verbose_json 是否成功
try {
  response = await client.audio.transcriptions.create({ response_format: 'verbose_json', ... })
} catch (err) {
  // 任何模型失敗都 fallback json，沒有針對特定模型的特殊路徑
  response = await client.audio.transcriptions.create({ response_format: 'json', ... })
}
```

---

### Q11：如果要做兩段式架構，AI Settings 需要如何改動？

**現有結構（單一 provider）：**

```
transcriptionProvider  → 'groq' | 'openai' | 'gemini'
transcriptionModel     → 'whisper-large-v3-turbo' 或 'gpt-4o-mini-transcribe'
```

只能選一個 provider + model 做轉錄。

**兩段式需要的結構：**

```
transcriptionTimestampProvider  ← 新增（取時間戳用，例如 groq）
transcriptionTimestampModel     ← 新增（例如 whisper-large-v3-turbo）
transcriptionTextProvider       ← 原本的 transcriptionProvider（取文字用）
transcriptionTextModel          ← 原本的 transcriptionModel（例如 gpt-4o-mini-transcribe）
```

**需要改動的地方：**

| 檔案                          | 改動                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `src/shared/contracts.ts`     | `AppSettingsView`、`SaveSettingsInput` 新增 4 個欄位                                     |
| `src/main/database.ts`        | `ProviderConfig` 拆分或新增 timestamp provider 欄位；`getProviderConfig()` 更新          |
| `src/main/database.ts`        | SQLite settings table 新增欄位（schema migration）                                       |
| `src/main/index.ts`           | `job:process` 中建立兩個 provider，先跑 timestamp provider，再跑 text provider，最後對齊 |
| `src/main/openai-provider.ts` | 新增 `alignTranscript(whisperSegments, gpt4oText)` 對齊函式                              |
| `src/renderer/src/App.tsx`    | AI Settings 對話框新增 timestamp provider/model 欄位                                     |

**改動量評估：中（約 200–300 行）**，且需要處理對齊算法的可靠性問題（見 Q8）。

**建議優先順序：**

1. ✅ 先做 Glossary 注入 Whisper prompt（~10 行，零風險）
2. 再評估兩段式是否仍需要
3. 如確定要兩段式，建議先完成步驟 1 後測試，確認提升幅度是否足夠
