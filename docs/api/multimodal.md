# API · 多模态输入与预处理

> 所有端点挂在 `/api/multimodal/*` 下，**不修改任何既有端点**。
> 响应统一为 `{ ok: true, ... }` / `{ ok: false, error: { code, message, details? } }`。
> 无鉴权（本地演示用），CORS 默认放开；生产部署请自行加网关鉴权。

**Base URL**：`http://localhost:8787`（由 `PORT` 决定）

---

## 1. 端点总览

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/multimodal/engines` | 查看 OCR 引擎状态（当前引擎、是否已配置、是否真实识别） |
| `GET` | `/api/multimodal/exams` | 评分体系列表（供上传页渲染下拉，数据来自既有引擎） |
| `POST` | `/api/multimodal/upload` | 上传图片/PDF → OCR → 预处理 → 调用既有评分管线 |
| `GET` | `/api/multimodal/submissions/{id}` | 取原图 URL、OCR 原文、标准化文本、预处理报告、评分结果 |
| `POST` | `/api/multimodal/submissions/{id}/confirm` | 人工校对文本后重新评分（保留 OCR 原文） |

---

## 2. POST /api/multimodal/upload

### 请求（两种方式等价）

**方式 A：multipart/form-data（浏览器 FormData，推荐）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | File | ✅ | PNG / JPG / WebP / PDF，≤ `MAX_UPLOAD_MB` |
| `exam_key` | string | ❌ | `gaokao` / `cet4` / `cet6` / `tem4` / `ielts` / `toefl`，默认 `cet4` |
| `student_id` | string | ❌ | 匿名学号，`^[A-Za-z0-9_-]{3,64}$`；不填则不进学习档案 |
| `ocr_engine` | string | ❌ | 临时覆盖 `OCR_ENGINE`（仅调试用） |

**方式 B：application/json + base64（便于脚本）**

```json
{
  "filename": "essay.png",
  "mime": "image/png",
  "data_base64": "iVBORw0KGgo...",
  "exam_key": "cet4",
  "student_id": "anon_demo_01"
}
```

### 响应 `201`

```json
{
  "ok": true,
  "created": true,
  "submission": {
    "id": "sub_5b4a180f9fd1",
    "student_id": "anon_demo_01",
    "source_type": "image",
    "created_at": "2026-11-25T11:40:12.345Z",
    "exam_key": "cet4",
    "exam_name": "大学英语四级 CET4 写作",
    "original_url": "/uploads/sub_5b4a180f9fd1.png",
    "original_filename": "printed_sample.png",
    "mime": "image/png",
    "bytes": 76768,
    "sha256": "39e8d098834122db…",
    "ocr_engine": "mock",
    "ocr_confidence": 0.96,
    "ocr_text": "Nowadays, more and more college students …",
    "normalized_text": "Nowadays, more and more college students …",
    "preprocess_report": {
      "engine": "mock",
      "confidence": 0.96,
      "confidence_threshold": 0.75,
      "needs_review": false,
      "review_reasons": [],
      "corrections": [],
      "warnings": [
        "engine=mock：文本来自 demo 夹具回放，不是真实 OCR 识别结果",
        "confidence 为夹具中的 demo 配置值，不代表真实识别质量"
      ],
      "steps": [
        { "name": "denoise_lines", "applied": false, "note": "未发现页码/横线" },
        { "name": "dehyphenate", "applied": false, "note": "处理 0 处跨行断词" }
      ],
      "stats": { "raw_chars": 826, "normalized_chars": 826, "raw_lines": 12, "paragraphs": 4, "words": 143 },
      "image": { "rotation_deg": 0, "denoise": "none", "binarized": false, "provenance": "…" }
    },
    "needs_review": false,
    "review_reasons": [],
    "confirmed": false,
    "edited": false,
    "grading": {
      "exam": { "key": "cet4", "name": "大学英语四级 CET4 写作", "totalMax": 15, "bands": [] },
      "total": 13,
      "totalMax": 15,
      "band": { "label": "优秀档（13–15 分）", "desc": "切题，表达思想清楚…", "min": 13 },
      "dims": [
        { "key": "content", "zh": "内容扣题与论点", "en": "Task Response", "max": 4,
          "score": 3.5, "normalized": 8.8, "ratio": 0.875, "counted": true }
      ],
      "stats": { "wordCount": 143, "sentenceCount": 13, "paraCount": 4, "ttr": 0.72 },
      "metrics": { "spellErr": 0, "transCount": 3, "complexCount": 7 },
      "findings": [ { "dim": "lexis", "title": "关键词重复过多", "severity": 3, "examples": ["students"] } ],
      "comment": { "strengths": ["…"], "problems": ["…"], "advice": ["…"], "verdict": "…" }
    },
    "analysis": { "error_categories": [], "lexical_diversity": {}, "structure_metrics": {} }
  }
}
```

> `grading` 与文本批改的返回**完全同构**（同由 `scoring-adapter.toGradingPayload()` 产出），
> 因此前端可视化（雷达图/分数条）与评语渲染逻辑可以复用，无需为新模块写第二套。

### 错误

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `NO_FILE` | 表单里没有文件字段 |
| 400 | `INVALID_EXAM` | `exam_key` 不在六套体系内（`details.allowed` 给出合法值） |
| 400 | `INVALID_REQUEST` | `student_id` 含非法字符（防 PII） |
| 413 | `PAYLOAD_TOO_LARGE` | 超过 `MAX_UPLOAD_MB` |
| 415 | `UNSUPPORTED_MEDIA` | 非 PNG/JPG/WebP/PDF |
| 422 | `TEXT_TOO_SHORT` | 识别后不足 5 词（`details.ocr_text` / `details.preprocess_report` 便于排查） |
| 503 | `OCR_ENGINE_UNAVAILABLE` | 引擎未配置（如 `OCR_ENGINE=paddle` 但未填 `PADDLEOCR_ENDPOINT`） |

失败时**不落库、不留原图**（已做清理，有单测覆盖）。

### curl 示例

```bash
curl -X POST http://localhost:8787/api/multimodal/upload \
  -F "file=@sample_data/images/printed_sample.png;type=image/png" \
  -F "exam_key=cet4" \
  -F "student_id=anon_demo_01"
```

---

## 3. GET /api/multimodal/submissions/{id}

返回与上传时相同的 `submission` 对象（`{ ok: true, submission: {...} }`）。
不存在时 `404 SUBMISSION_NOT_FOUND`。

前端可用 `?submission=<id>` 直接打开历史结果页：
`/frontend/src/pages/MultimodalUpload/index.html?submission=sub_5b4a180f9fd1`

---

## 4. POST /api/multimodal/submissions/{id}/confirm

识别结果经过人工校对后，用校对文本重新走一遍既有评分。

```json
{ "normalized_text": "I think a part-time job is good for students …", "exam_key": "cet4" }
```

响应 `200 { ok: true, created: false, submission: {...} }`，其中：

- `confirmed: true`、`edited: true`（若文本与 `ocr_text` 不同）；
- `normalized_text` 更新为校对版，**`ocr_text` 保持 OCR 原始输出不变**（可追溯）；
- `preprocess_report.needs_review` 置为 `false`，并写入 `reviewed_at` / `review_note`。

---

## 5. GET /api/multimodal/engines

```json
{
  "ok": true,
  "active": "mock",
  "confidence_threshold": 0.75,
  "engines": [
    { "name": "mock",   "active": true,  "configured": true,  "note": "mock 引擎仅回放 demo 夹具，不执行真实识别", "real_recognition": false },
    { "name": "paddle", "active": false, "configured": false, "note": "未配置 PADDLEOCR_ENDPOINT，无法调用 PaddleOCR 服务", "real_recognition": true },
    { "name": "vlm",    "active": false, "configured": false, "note": "未配置 VLM_ENDPOINT，无法调用视觉模型转录", "real_recognition": true },
    { "name": "cloud",  "active": false, "configured": false, "note": "未配置 CLOUD_OCR_ENDPOINT，无法调用云 OCR", "real_recognition": true }
  ]
}
```

---

## 6. 如何接入一个新的 OCR 引擎

1. 在 `backend/app/modules/multimodal/ocr/` 新建 `xxx-engine.js`，实现：

```js
export const xxxEngine = {
  name: 'xxx',
  available() {                     // 返回 { ok:boolean, reason:string }
    return { ok: Boolean(process.env.XXX_ENDPOINT), reason: '未配置 XXX_ENDPOINT' };
  },
  async recognize({ buffer, filename, mime, sha256, lang }) {
    return {
      engine: 'xxx',
      text: '……',                   // 原始转录（不要在这里做拼写纠正）
      confidence: 0.93,             // 没有就返回 null，不要编造
      warnings: [],                 // 引擎侧告警，会进 preprocess_report
      image_meta: { rotation_deg: 0 }  // 引擎自报的图像处理结果（可选）
    };
  }
};
```

2. 在 `ocr/index.js` 的 `ENGINES` 里注册，并在 `.env.example` 增加对应变量；
3. 把 `OCR_ENGINE` 设成新名字即可切换——**不需要改 service / routes / 前端**。

现成的三个远端引擎（`paddle` / `vlm` / `cloud`）用 `ocr/remote-base.js` 的工厂函数，
只需提供 `buildRequest` 与 `parseResponse`；`normalizeOcrPayload()` 已兼容
`{text}` / `{results:[{text,score}]}` / `{Result:{Text}}` / `{words_result:[{words}]}` 等常见形态。

---

## 7. 预处理报告字段说明

| 字段 | 含义 |
| --- | --- |
| `confidence` | 引擎给出的置信度（0–1）。引擎不提供时为 `null`（此时一定 `needs_review=true`） |
| `confidence_threshold` | 判定复核的阈值，来自 `OCR_CONFIDENCE_THRESHOLD` |
| `needs_review` | 是否需要人工复核。**不阻断评分**，只提示 |
| `review_reasons` | 触发复核的具体原因（置信度低 / 无置信度 / 词数过少 / 无句末标点） |
| `corrections` | 做过的修改：`type`（punctuation/hyphenation/spacing/paragraph/ocr_confusion/layout_noise）、`count`、`note`、`samples` |
| `warnings` | 引擎告警 + 预处理告警（均为中文可读） |
| `steps` | 每一步是否生效及说明，便于课堂逐条讲解 |
| `stats` | `raw_chars / normalized_chars / raw_lines / paragraphs / words` |
| `image` | 引擎自报的图像级处理结果；`mock` 不做像素运算，此字段来自夹具声明 |

### 预处理做了什么 / 不做什么

| 做（形式层，可回放） | 不做（避免改原意） |
| --- | --- |
| 全角/中文标点 → 英文半角 | 替换同义词、润色句子 |
| 弯引号 → 直引号 | 补全缺失的主语/谓语 |
| 跨行断词合并（`gover-\nment`） | 自动改写拼写（见下） |
| 连字 `ﬁ`/`ﬂ` 拆分 | 改写段落顺序 |
| 孤立页码、页眉横线清理 | 增删任何实词 |
| 标点前后空格规范化 | 翻译 |
| 段落还原（空行 / 缩进 / 句末标点三种信号） | 判分 |
| 受限的 OCR 混淆修正（`|`→`I`、`T0`→`TO`） | — |
| 拼写问题**只标记不改写**（写进 `spelling_flags`） | — |
