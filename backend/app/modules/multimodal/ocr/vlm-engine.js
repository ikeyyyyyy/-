/**
 * VLM 引擎适配器（视觉大模型整页转录）。
 * 契约：POST {VLM_ENDPOINT}（OpenAI 兼容 /chat/completions）
 *   body: { model, messages: [{role:'user', content:[{type:'text'...},{type:'image_url'...}]}] }
 *   resp: { choices: [{ message: { content } }] }
 *
 * 注意：这类接口通常不返回置信度。本适配器不会编造 confidence，
 * 而是返回 null，让 preprocess 标 needs_review=true（"引擎未返回置信度，需人工复核"）。
 */
import { config } from '../../../config.js';
import { createRemoteEngine } from './remote-base.js';

const PROMPT = [
  'You are an OCR engine. Transcribe the English essay in this image exactly as written.',
  'Rules:',
  '1. Output plain text only. Keep the original paragraph breaks.',
  '2. Preserve the student\'s spelling and grammar mistakes — do NOT correct them.',
  '3. Do not add comments, translations, or explanations.',
  '4. If a word is illegible, write [illegible].'
].join('\n');

export const vlmEngine = createRemoteEngine({
  name: 'vlm',
  timeoutMs: config.ocr.vlm.timeoutMs,

  available() {
    if (!config.ocr.vlm.endpoint) {
      return { ok: false, reason: '未配置 VLM_ENDPOINT，无法调用视觉模型转录' };
    }
    if (!config.ocr.vlm.model) {
      return { ok: false, reason: '未配置 VLM_MODEL，无法指定视觉模型' };
    }
    return { ok: true, reason: '已配置 VLM 端点', endpoint: config.ocr.vlm.endpoint };
  },

  buildRequest({ imageBase64, mime }) {
    return {
      url: config.ocr.vlm.endpoint,
      headers: config.ocr.vlm.apiKey ? { Authorization: `Bearer ${config.ocr.vlm.apiKey}` } : {},
      body: {
        model: config.ocr.vlm.model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }
            ]
          }
        ]
      }
    };
  },

  parseResponse(json) {
    const content = json?.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('\n')
        : '';
    return {
      text,
      confidence: null,   // 不编造
      warnings: ['VLM 转录不提供置信度，已标记为需人工复核']
    };
  }
});
