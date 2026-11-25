/**
 * 服务入口（零依赖，只用 Node 内置 http）。
 *
 * 启动：node backend/server.js   （或 npm start）
 * 测试：直接 import { startServer } 起一个临时端口，不需要额外进程管理。
 *
 * 路由分层：
 *   /api/multimodal/*  -> 多模态模块
 *   /api/analytics/*   -> 学习分析模块
 *   /api/health        -> 健康检查（含 schema 版本，便于排查迁移）
 *   其余               -> 静态文件（index.html 与新增页面）
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './app/config.js';
import { AppError, ERR } from './app/errors.js';
import { Router } from './app/http/router.js';
import { ok, fail, applyCors, sendJson } from './app/http/respond.js';
import { serveStatic } from './app/http/static.js';
import { initStore, getStoreInfo } from './app/store/db.js';
import { registerMultimodalRoutes } from './app/modules/multimodal/routes.js';
import { registerAnalyticsRoutes } from './app/modules/analytics/routes.js';

export function buildRouter() {
  const router = new Router();

  router.get('/api/health', (req, res) => {
    ok(res, {
      status: 'ok',
      time: new Date().toISOString(),
      store: getStoreInfo(),
      modules: ['grading', 'visualization', 'comment', 'standard-alignment', 'multimodal', 'analytics'],
      ocr_engine: config.ocr.engine,
      endpoints: router.list().filter(p => !p.includes('/health'))
    });
  });

  registerMultimodalRoutes(router);
  registerAnalyticsRoutes(router);
  return router;
}

export function createHandler(router) {
  return async function handler(req, res) {
    applyCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const matched = router.match(req.method, url.pathname);

    if (matched) {
      try {
        await matched.handler(req, res, { params: matched.params, url });
      } catch (err) {
        if (!res.headersSent) fail(res, err);
        else res.end();
      }
      return;
    }

    // /api/* 未命中 -> JSON 404（不要让前端拿到 HTML）
    if (url.pathname.startsWith('/api/')) {
      fail(res, new AppError(ERR.NOT_FOUND, `未知接口：${req.method} ${url.pathname}`, 404));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        if (await serveStatic(req, res, url.pathname)) return;
      } catch (err) {
        console.error('[static]', err);
      }
    }

    if (url.pathname === '/') {
      sendJson(res, 404, { ok: false, error: { code: ERR.NOT_FOUND, message: 'index.html 不存在' } });
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: ERR.NOT_FOUND, message: '资源不存在' } });
  };
}

/**
 * 启动服务。
 * @param {object} [opts]
 * @param {number} [opts.port] 传 0 表示随机可用端口（测试用）
 * @param {string} [opts.host]
 * @param {object} [opts.store] 覆盖存储路径，测试时指向临时目录，避免污染真实数据
 */
export async function startServer(opts = {}) {
  await initStore(opts.store || {});
  const router = buildRouter();
  const server = http.createServer(createHandler(router));

  const port = opts.port ?? config.port;
  const host = opts.host ?? config.host;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`;
  return {
    server,
    router,
    port: addr.port,
    url,
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/* 直接运行时才监听端口（被 import 时不自动启动） */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then(({ url }) => {
      const info = getStoreInfo();
      console.log(`\n  English Essay Grader 已启动`);
      console.log(`  ├─ 批改页        ${url}/index.html`);
      console.log(`  ├─ 多模态上传    ${url}/frontend/src/pages/MultimodalUpload/index.html`);
      console.log(`  ├─ 学习档案      ${url}/frontend/src/pages/LearningProfile/index.html`);
      console.log(`  ├─ 健康检查      ${url}/api/health`);
      console.log(`  ├─ OCR 引擎      ${config.ocr.engine}`);
      console.log(`  └─ 数据库        v${info.schema_version}，${info.submissions} 条提交\n`);
    })
    .catch(err => {
      console.error('启动失败：', err);
      process.exit(1);
    });
}
