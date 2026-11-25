/**
 * 通用云 OCR 适配器（阿里云/腾讯云/百度等都能对接，只要网关按下面契约包一层）。
 * 契约：POST {CLOUD_OCR_ENDPOINT}
 *   headers: { X-OCR-Provider, Authorization: Bearer <CLOUD_OCR_KEY> }
 *   body: { image_base64, mime, lang }
 *   resp: { text, confidence } | { Result:{Text,Confidence} } | { words_result:[{words}] }
 */
import { config } from '../../../config.js';
import { createRemoteEngine, normalizeOcrPayload } from './remote-base.js';

export const cloudEngine = createRemoteEngine({
  name: 'cloud',
  timeoutMs: config.ocr.cloud.timeoutMs,

  available() {
    if (!config.ocr.cloud.endpoint) {
      return { ok: false, reason: '未配置 CLOUD_OCR_ENDPOINT，无法调用云 OCR' };
    }
    if (!config.ocr.cloud.key) {
      return { ok: false, reason: '未配置 CLOUD_OCR_KEY（密钥只从环境变量读取，不入库）' };
    }
    return { ok: true, reason: '已配置云 OCR 端点', endpoint: config.ocr.cloud.endpoint };
  },

  buildRequest({ imageBase64, mime, lang }) {
    return {
      url: config.ocr.cloud.endpoint,
      headers: {
        'X-OCR-Provider': config.ocr.cloud.provider || 'generic',
        Authorization: `Bearer ${config.ocr.cloud.key}`
      },
      body: { image_base64: imageBase64, mime, lang }
    };
  },

  parseResponse(json) {
    return normalizeOcrPayload(json);
  }
});
