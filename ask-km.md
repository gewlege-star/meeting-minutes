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

| 方案 | 特色 |
|---|---|
| **AssemblyAI** | 原生支援，API 直接返回 `speaker_A / speaker_B` 標籤，最易整合 |
| **Deepgram Nova-2** | 支援 `diarize=true` 參數，自動標記說話者 |
| **Pyannote（本地）** | 開源說話者分離模型，搭配 Whisper 做後處理，需本地執行 |
| **Azure Speech** | 支援對話轉錄模式，內建說話者識別 |
| **Google Cloud Speech-to-Text v2** | 支援 `speaker_diarization_config` |
| **GPT-4o Audio** | 若 prompt 指定說話者識別，有時能從語意推斷，但**不保證準確** |

**目前 App 最小改動整合路徑：AssemblyAI 或 Deepgram**（轉錄 API 直接帶說話者標籤）。

---

### Q3：音檔切割為 2 分鐘的原因與最佳長度？

**A：**

| 考量點 | 說明 |
|---|---|
| **Whisper 解碼器幻覺（最主要）** | Whisper 的 Attention Window 設計以 30 秒為一單元。長音檔含靜音/噪音時，解碼累積誤差自我強化，造成「無限重複同一句話」的幻覺。2 分鐘切片能強行重置 Context。 |
| **API 上傳容量與逾時** | 多數 API 代理有 25MB 上傳限制；2 分鐘 normalized MP3 通常僅幾百 KB，100% 傳輸成功。 |
| **容錯重試** | 單段失敗只需重試 2 分鐘的切片，不需整場重來。 |

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
