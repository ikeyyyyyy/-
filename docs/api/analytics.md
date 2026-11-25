# API · 学习分析与个性化写作档案

> 所有端点挂在 `/api/analytics/*` 下。**只读历史批改记录做聚合，不参与任何打分**。
> 评分仍然只由既有引擎（`index.html` → `analyzeEssay`）产出，本模块仅在上层做统计。

**Base URL**：`http://localhost:8787`

---

## 1. 端点总览

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/analytics/records` | 记录入库（文本提交；内部调用既有评分适配器） |
| `GET` | `/api/analytics/students` | 学生列表（按最近提交排序） |
| `GET` | `/api/analytics/students/{id}/dashboard` | 趋势仪表盘：评分 / 错误类型 / 词汇多样性 / 结构完整度 |
| `GET` | `/api/analytics/students/{id}/profile` | 个性化档案：顽固错误 Top 3、优势项、升档建议、跨篇提示 |
| `GET` | `/api/analytics/students/{id}/timeline` | 提交时间线（倒序） |
| `DELETE` | `/api/analytics/students/{id}` | 隐私删除：记录 + 上传原图一并清除 |

`student_id` 校验规则：`^[A-Za-z0-9_-]{3,64}$`。**故意的限制**——不允许邮箱、手机号、中文姓名进入系统，从入口杜绝 PII。

**空数据不报错**：未知学号 / 无历史时，三个 GET 端点都返回 `200` + `empty: true` + `message: "暂无历史数据"`，前端直接显示占位即可。

---

## 2. POST /api/analytics/records

### 请求

```json
{
  "text": "Nowadays an increasing number of college students take part-time jobs …",
  "exam_key": "cet4",
  "student_id": "anon_demo_01",
  "created_at": "2026-11-20T09:00:00.000Z",
  "meta": { "class": "demo" }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `text` | ✅ | 作文正文（空/纯空白 → `400 EMPTY_TEXT`） |
| `exam_key` | ❌ | 默认 `cet4`；非法 → `400 INVALID_EXAM` |
| `student_id` | ❌ | 不填则记录为 `null`，不进任何学生的聚合 |
| `created_at` | ❌ | 补录历史数据用（seed 脚本就靠它造时间序列） |
| `meta` | ❌ | 任意附加信息，原样存回（demo 数据会带 `seeded: true`） |

### 响应 `201`

```json
{
  "ok": true,
  "submission_id": "sub_a1b2c3d4e5f6",
  "student_id": "anon_demo_01",
  "created_at": "2026-11-20T09:00:00.000Z",
  "exam_key": "cet4",
  "total": 13,
  "total_max": 15,
  "band_label": "优秀档（13–15 分）",
  "deduplicated": false,
  "hint": {
    "available": true,
    "mode": "recur",
    "text": "你上次（2026-11-18）也犯了类似的「词汇重复」问题，近 5 篇里出现了 3 次。",
    "category": "repetition",
    "category_label": "词汇重复",
    "occurrences": 3,
    "sample_size": 5,
    "dismissible": true,
    "examples": ["students"]
  }
}
```

- **幂等**：同一 `student_id` 提交完全相同的文本会返回已有记录，`deduplicated: true`，不会污染趋势（有单测）。
- `hint` 随入库直接返回，批阅页因此不需要额外一次请求。

---

## 3. GET /api/analytics/students/{id}/dashboard

```json
{
  "ok": true,
  "student_id": "anon_demo_01",
  "student_known": true,
  "empty": false,
  "submission_count": 5,
  "range": { "from": "2026-10-28T11:39:49.271Z", "to": "2026-11-23T11:39:49.271Z" },
  "score": {
    "points": [
      { "submission_id": "sub_1", "at": "2026-10-28T…", "date": "2026-10-28",
        "exam_key": "cet4", "total": 6, "total_max": 15, "percent": 40,
        "band_label": "较差档（4–6 分）" }
    ],
    "first":  { "total": 6,  "percent": 40 },
    "latest": { "total": 13, "percent": 86.7 },
    "best":   { "total": 13, "percent": 86.7 },
    "average_percent": 63.9,
    "trend": "up",
    "delta": 46.7
  },
  "dimensions": {
    "keys": ["content", "structure", "lexis", "grammar", "mechanics"],
    "series": {
      "content": { "zh": "内容扣题与论点", "points": [ { "at": "…", "value": 3.75 } ],
                   "average": 7.8, "trend": "up", "delta": 4.6 }
    },
    "averages": { "content": 7.8, "structure": 7.2, "lexis": 7.6, "grammar": 6.9, "mechanics": 10 }
  },
  "error_categories": {
    "codes": ["repetition", "spelling", "vague_wording"],
    "points": [
      { "at": "2026-10-28T…", "submission_id": "sub_1",
        "counts": { "repetition": 1, "vague_wording": 1 }, "total": 2 }
    ],
    "totals": [
      { "code": "repetition", "label": "词汇重复", "occurrences": 4, "submissions": 3,
        "rate": 0.6, "severity": 3, "last_seen": "2026-11-23T…", "trend": "down",
        "delta_submissions": -1 }
    ]
  },
  "lexical_diversity": {
    "points": [ { "at": "…", "ttr": 0.712, "advanced_ratio": 0.09, "word_count": 91 } ],
    "average_ttr": 0.788,
    "average_advanced_ratio": 0.11,
    "trend": "up",
    "delta": 0.061
  },
  "structure": {
    "points": [ { "at": "…", "paragraphs": 1, "sentences": 9, "transitions": 0,
                  "complex_sentences": 2, "avg_sentence_length": 10.1,
                  "dimension_normalized": 3.3 } ],
    "averages": { "paragraphs": 3.6, "transitions": 2.4, "complex_sentences": 3.6,
                  "avg_sentence_length": 13.4 },
    "trend": "up",
    "delta": 6.7
  },
  "exams": ["cet4"]
}
```

字段语义：

| 字段 | 说明 |
| --- | --- |
| `score.percent` | 得分 / 满分 × 100，**用来跨体系比较**（换体系后满分不同，不能直接比原始分） |
| `score.trend` | `up` / `down` / `flat` / `insufficient`（不足 2 篇）。阈值 3 个百分点 |
| `dimensions.series[k].trend` | 首末对比，阈值 0.5 分（0–10 制） |
| `error_categories.totals[].trend` | 前后半段出现篇数对比：后半段变多 = `up`（变差） |
| `lexical_diversity.trend` | TTR 首末对比，阈值 0.03 |

---

## 4. GET /api/analytics/students/{id}/profile

可选参数 `?current=<submission_id>`：指定"当前正在看的那篇"，用于生成对应的跨篇提示。

```json
{
  "ok": true,
  "student_id": "anon_demo_01",
  "student_known": true,
  "empty": false,
  "sample_size": 5,
  "range": { "from": "2026-10-28T…", "to": "2026-11-23T…" },
  "stubborn_errors": [
    { "code": "repetition", "label": "词汇重复", "submissions": 3, "occurrences": 4,
      "rate": 0.6, "severity": 3, "last_seen": "2026-11-23T…", "trend": "down",
      "examples": ["建议准备 2–3 个同义替换"], "dates": ["2026-10-28", "…"] },
    { "code": "spelling",      "label": "拼写错误", "submissions": 2, "occurrences": 2, "severity": 3 },
    { "code": "vague_wording", "label": "用词笼统", "submissions": 2, "occurrences": 2, "severity": 1 }
  ],
  "strengths": [
    { "key": "mechanics", "zh": "格式标点规范", "average": 10, "best": 10 },
    { "key": "content",   "zh": "内容扣题与论点", "average": 7.8, "best": 8.8 }
  ],
  "focus": { "key": "grammar", "zh": "语法与句式多样", "average": 6.9, "best": 8.3 },
  "band_up_advice": [
    { "text": "同一关键词出现 3 次以上就换同义表达，或用代词、上位词指代。",
      "based_on": "顽固错误「词汇重复」：3/5 篇出现", "category": "repetition" },
    { "text": "每篇刻意用 2 个非谓语结构和 1 个定语从句，先把结构用对，再追求复杂。",
      "based_on": "最弱维度「语法与句式多样」均值 6.9/10", "category": "grammar" }
  ],
  "hint": {
    "available": true,
    "mode": "recur",
    "dismissible": true,
    "text": "你上次（2026-11-25）也犯了类似的「词汇重复」问题，近 6 篇里出现了 4 次。",
    "category": "repetition",
    "category_label": "词汇重复",
    "occurrences": 4,
    "sample_size": 6,
    "examples": ["建议准备 2–3 个同义替换"]
  },
  "summary": "已积累 5 篇批改记录，最近一篇落在「优秀档」，最顽固的问题是词汇重复（3 篇出现），相对优势是格式标点规范。"
}
```

### 顽固错误判定口径（可解释）

1. 先按 `record-adapter` 的错误分类，把每篇的 `findings` 归到 22 个类别；
2. 只保留**出现篇数 ≥ 2**（可用 `ANALYTICS_STUBBORN_MIN_OCCURRENCES` 调高）的类别；
3. 排序：`出现篇数` → `严重度` → `累计次数`，取前 3；
4. `trend` 用前后半段对比，说明这类错误在"变多"还是"变少"，而不是只给一个静态标签。

### 跨篇提示的两种口径

| mode | 触发条件 | 文案形态 | 为什么这么设计 |
| --- | --- | --- | --- |
| `recur` | 当前这篇**也出现了**历史顽固错误 | 「你上次（11-25）也犯了类似的「词汇重复」问题…」 | 有事实依据，可以直接说"也犯了" |
| `watch` | 当前这篇没出现，但历史上有顽固错误 | 「近 5 篇里「拼写错误」出现了 3 次，交卷前建议专门检查一遍。」 | 不能谎称"这篇也错了"，改成提醒口吻 |
| `none` | 历史 < 2 篇，或无重复错误 | 不可用，`reason` 说明原因 | 早期不硬凑 |

提示 `dismissible: true`，前端关闭后写入 `localStorage`（`eg_hint_off`），不再打扰；批阅页提供"重新开启"。

---

## 5. GET /api/analytics/students/{id}/timeline

```json
{
  "ok": true,
  "student_id": "anon_demo_01",
  "student_known": true,
  "count": 5,
  "empty": false,
  "items": [
    { "submission_id": "sub_c747b242d186", "at": "2026-11-25T11:39:49.271Z",
      "date": "2026-11-25", "exam_key": "cet4", "exam_name": "大学英语四级 CET4 写作",
      "total": 13, "total_max": 15, "percent": 86.7, "band_label": "优秀档（13–15 分）",
      "source_type": "image", "needs_review": false, "confirmed": false }
  ]
}
```

倒序（最新在前）。`source_type` 区分文本 / 图片 / PDF，`needs_review` 标记未经人工核对的 OCR 结果。

---

## 6. DELETE /api/analytics/students/{id}

```json
{ "ok": true, "student_id": "anon_demo_01", "removed_submissions": 5, "removed_assets": 1 }
```

同时删除 `backend/data/uploads/` 下对应的原图文件（失败不阻断，返回值里如实计数）。

---

## 7. 在已有页面上调用（说明性示例）

```js
// 批阅页：存一次批改，并拿到跨篇提示
const res = await fetch('/api/analytics/records', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: essayText,          // 就是当前文本框里的内容
    exam_key: examSelect.value,
    student_id: studentInput.value   // 匿名学号，可留空
  })
});
const { hint } = await res.json();
if (hint?.available) showHint(hint.text);   // 用户可关闭，见 eg_hint_off
```

`index.html` 里对应的实现是 `maybeAutoSync()` / `syncToProfile()` / `renderProfileHint()`，
全部包在 `try/catch` 中——服务没启动时页面与原来完全一致。
