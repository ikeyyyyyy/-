/**
 * 远端 OCR 引擎的公共部分：超时、错误包装、响应归一化。
 *
 * 三个引擎（paddle / vlm / cloud）的差异只在「请求体怎么拼、响应怎么解析」，
 * 所以这里抽一个工厂函数，各引擎只提供 buildRequest / parseResponse。
 */
import { AppError, ERR } from '../../../errors.js';

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {() => {ok:boolean, reason:string, endpoint?:string}} spec.available
 * @param {(args:object) => {url:string, headers:object, body:any}} spec.buildRequest
 * @param {(json:any, raw:string) => {text:string, confidence:number|null, warnings?:string[], image_meta?:object}} spec.parseResponse
 * @param {number} spec.timeoutMs
 * @param {string} spec.endpoint
 */
export function createRemoteEngine(spec) {
  return {
    name: spec.name,
    available: spec.available,

    async recognize({ buffer, filename, mime, lang }) {
      const state = spec.available();
      if (!state.ok) {
        throw new AppError(ERR.OCR_ENGINE_UNAVAILABLE, state.reason, 503, { engine: spec.name });
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), spec.timeoutMs);
      try {
        const { url, headers, body } = spec.buildRequest({
          buffer,
          filename,
          mime,
          lang,
          imageBase64: buffer.toString('base64')
        });
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: abort.signal
        });
        const raw = await res.text();
        if (!res.ok) {
          throw new AppError(ERR.OCR_FAILED, `OCR 服务返回 ${res.status}`, 502, {
            engine: spec.name,
            body: raw.slice(0, 300)
          });
        }
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new AppError(ERR.OCR_FAILED, 'OCR 服务返回的不是合法 JSON', 502, { engine: spec.name });
        }
        const parsed = spec.parseResponse(json, raw);
        return {
          engine: spec.name,
          text: parsed.text || '',
          confidence: parsed.confidence ?? null,
          warnings: parsed.warnings || [],
          image_meta: parsed.image_meta || null
        };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err.name === 'AbortError') {
          throw new AppError(ERR.OCR_FAILED, `OCR 服务超时（>${spec.timeoutMs}ms）`, 504, { engine: spec.name });
        }
        throw new AppError(ERR.OCR_FAILED, `OCR 调用失败：${err.message}`, 502, { engine: spec.name });
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * 常见 OCR 响应形态归一化：
 *  - PaddleOCR 自建服务：{ text } 或 { results: [{ text, score }] } 或 { data: [{ text }] }
 *  - 云厂商：{ text } / { Result: { Text } } / { words_result: [{words}] }
 * 统一成 { text, confidence }，confidence 取各段平均（没给就是 null，不猜）。
 */
export function normalizeOcrPayload(json) {
  const warnings = [];

  const pickArray = () => {
    for (const key of ['results', 'data', 'words_result', 'lines', 'blocks']) {
      if (Array.isArray(json?.[key])) return json[key];
    }
    if (Array.isArray(json?.Result?.Items)) return json.Result.Items;
    return null;
  };

  const arr = pickArray();
  if (arr) {
    const texts = [];
    const scores = [];
    for (const item of arr) {
      const t = item?.text ?? item?.words ?? item?.content ?? item?.Text ?? '';
      if (t) texts.push(String(t));
      const s = item?.confidence ?? item?.score ?? item?.Confidence ?? item?.Score;
      if (typeof s === 'number') scores.push(s > 1 ? s / 100 : s);   // 兼容 0–100 制
    }
    const confidence = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    if (confidence === null) warnings.push('OCR 响应未提供置信度，已标记为需人工复核');
    return { text: texts.join('\n'), confidence, warnings };
  }

  const direct =
    json?.text ?? json?.Text ?? json?.Result?.Text ?? json?.data?.text ?? json?.result?.text ?? null;
  if (typeof direct === 'string') {
    const s = json?.confidence ?? json?.score ?? json?.Result?.Confidence;
    const confidence = typeof s === 'number' ? (s > 1 ? s / 100 : s) : null;
    if (confidence === null) warnings.push('OCR 响应未提供置信度，已标记为需人工复核');
    return { text: direct, confidence, warnings };
  }

  return { text: '', confidence: null, warnings: ['无法从 OCR 响应中定位文本字段（见 docs/api/multimodal.md 的响应契约）'] };
}
