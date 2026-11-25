/**
 * PaddleOCR 引擎适配器。
 * 契约：POST {PADDLEOCR_ENDPOINT}
 *   body: { image_base64, mime, lang }
 *   resp: { text } | { results: [{ text, score }] }   ← 两种都兼容
 * 图像级预处理（方向矫正/去噪）交给 PaddleOCR 服务侧完成，服务可在响应里回传
 * image_meta（例如 { rotation_deg, deskewed: true }），本适配器原样透传给预处理报告。
 */
import { config } from '../../../config.js';
import { createRemoteEngine, normalizeOcrPayload } from './remote-base.js';

export const paddleEngine = createRemoteEngine({
  name: 'paddle',
  timeoutMs: config.ocr.paddle.timeoutMs,

  available() {
    const endpoint = config.ocr.paddle.endpoint;
    if (!endpoint) {
      return { ok: false, reason: '未配置 PADDLEOCR_ENDPOINT，无法调用 PaddleOCR 服务' };
    }
    return { ok: true, reason: '已配置 PaddleOCR 服务', endpoint };
  },

  buildRequest({ imageBase64, mime, lang }) {
    return {
      url: config.ocr.paddle.endpoint,
      headers: config.ocr.paddle.apiKey ? { Authorization: `Bearer ${config.ocr.paddle.apiKey}` } : {},
      body: { image_base64: imageBase64, mime, lang }
    };
  },

  parseResponse(json) {
    const normalized = normalizeOcrPayload(json);
    return {
      ...normalized,
      image_meta: json?.image_meta || json?.meta?.image || null
    };
  }
});
