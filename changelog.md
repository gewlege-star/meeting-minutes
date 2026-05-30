# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0-beta] - 2026-05-30

### Added

- **Glossary 重複項目偵測 (Duplicate Entry Detection)**: 新增詞彙表時，若來源詞彙（sourceTerm）已存在，立即顯示錯誤提示，防止重複建立或靜默覆蓋。
- **Glossary 即時搜尋 (Glossary Search)**: 詞彙表對話框頂部新增搜尋輸入框，即時過濾顯示符合來源詞或目標詞的項目，方便快速確認詞彙是否重複。
- **開發知識庫 ask-km.md**: 建立 `ask-km.md` 文件，記錄本專案開發過程中的重要問答知識（低信心標記原理、說話者識別方案、音檔切割最佳長度、版號邏輯等）。

## [0.1.0-beta] - 2026-05-30

### Added

- **逐字稿編輯對話框極致放大 (Expanded Transcript Edit Dialog)**: 雙擊逐字稿段落不再使用行內細窄輸入框，改為開啟寬高均佔螢幕 80% 的大尺度編輯 modal 對話框。內部配備自適應多行文本框 (`<textarea>`)，極佳適配長篇逐字段落修改與對齊。按 `Enter` 快速储存並關閉，而 `Shift + Enter` 在大對話框中提供彈性換行，`Escape` 或取消按鈕則直接關閉 dialog，完美兼顧效率與舒適度。
- **逐字稿多向高亮搜尋與快速導覽 (Transcript Search Prev/Next Navigation)**: 
  - 精實置入搜尋結果統計（如 `目前匹配/總數` 段落計數，例如 `1/3`）。
  - 對應加入 ◀（上一個）與 ▶（下一個）側向導覽按鈕。
  - 當焦點處於搜尋輸入欄時，直接按 `Enter` 滑順跳轉下一個，按 `Shift + Enter` 往回跳轉上一個（邊界自動循環），高亮句自帶琥珀色邊框聚焦並自動平滑滾動至可視區域。

## [0.0.1-beta] - 2026-05-30

### Added

- **自動跟隨/追蹤當前段落功能與開關按鈕 (Active Segment Tracking & Toggle Button)**: 在會議裁剪「開始/停止標記」按鈕右側新增了一個「🎯 追蹤當前段落」按鈕。點擊即可自由開啟或關閉字幕自動滾動聚焦 (focus highlight) 與居中滾動的功能。當觀看或修改其他段落內容時，關閉追蹤即可防止進度更新拉回焦點，大幅提升閱讀與編輯體驗。

### Fixed

- **語音分段長度優化 (Audio Chunk Segmentation)**: 將音檔切片時間從 20 分鐘縮短回原來的 2 分鐘。此調整大幅提升了逐字稿對長音檔的處理反應速度，並顯著解決了 Whisper/相容模型在面對極長段落時因靜音或低品質音訊而產生的無限重複句子幻覺（Transcription Hallucinations）。
- **非標準 API 降級相容 (Fallback Logic for Custom Transcription Models)**: 
  - 優化非標準/第三方 OpenAI 相容代理，在遇到模型不支援語音識別 `verbose_json` 格式時（如用戶使用的 `gpt-4o-mini-transcribe-api-ev3`），能夠優雅地自動降級為標準 `json` 格式。
  - 將控制台警示從 `console.warn` 變更為簡潔的層級日誌 `console.log`，避免不必要的黃色警告塞滿終端機，降低雜訊。
- **自動時間段插值對齊 (Segment Interpolation)**: 針對使用備用 `json` 或部分 Gemini 模型（這些模型僅能返回完整逐字文字，無法返回原生高精準時間戳段落）的情況，新增智慧句子切割與時長均分插值對齊。不論何種模型，產出的逐字稿依然能在 UI 中享有精準、美觀的時間段與點擊編輯。
