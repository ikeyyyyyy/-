/**
 * OCR 引擎注册表：通过 OCR_ENGINE 环境变量切换，不硬编码单一引擎。
 * 新增引擎只需实现 {name, available(), recognize()} 并在此注册。
 */
import { config } from '../../../config.js';
import { AppError, ERR } from '../../../errors.js';
import { mockEngine } from './mock-engine.js';
import { paddleEngine } from './paddle-engine.js';
import { vlmEngine } from './vlm-engine.js';
import { cloudEngine } from './cloud-engine.js';

const ENGINES = {
  mock: mockEngine,
  paddle: paddleEngine,
  vlm: vlmEngine,
  cloud: cloudEngine
};

export const ENGINE_NAMES = Object.keys(ENGINES);

/**
 * @param {string} [name] 覆盖配置里的默认引擎
 */
export function resolveEngine(name) {
  const key = (name || config.ocr.engine || 'mock').toLowerCase();
  const engine = ENGINES[key];
  if (!engine) {
    throw new AppError(ERR.OCR_ENGINE_UNAVAILABLE, `未知的 OCR 引擎：${key}`, 400, { allowed: ENGINE_NAMES });
  }
  return engine;
}

/** 供 /api/multimodal/engines 使用：前端可据此提示用户当前引擎是否可真实识别 */
export function describeEngines() {
  return ENGINE_NAMES.map(name => {
    const state = ENGINES[name].available();
    return {
      name,
      active: name === config.ocr.engine,
      configured: state.ok,
      note: state.reason,
      real_recognition: name !== 'mock'
    };
  });
}
