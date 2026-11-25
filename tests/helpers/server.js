/**
 * 测试辅助：起一个使用临时目录的服务实例，跑完自动清理。
 * 用临时目录是为了绝不动 backend/data 下的真实数据。
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../backend/server.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @param {(ctx:{url:string, tmp:string, get:(p:string)=>Promise<any>, post:(p:string, body:any)=>Promise<any>, upload:(p:string, form:FormData)=>Promise<{status:number, body:any}>, raw:(p:string, init?:object)=>Promise<Response>}) => Promise<any>} fn
 */
export async function withServer(fn) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'eg-test-'));
  const s = await startServer({
    port: 0,
    store: { dataDir: tmp, uploadDir: path.join(tmp, 'uploads'), dbFile: path.join(tmp, 'db.json') }
  });

  const ctx = {
    url: s.url,
    tmp,
    raw: (p, init) => fetch(s.url + p, init),
    async get(p) {
      const res = await fetch(s.url + p);
      return { status: res.status, body: await res.json() };
    },
    async post(p, body) {
      const res = await fetch(s.url + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { status: res.status, body: await res.json() };
    },
    async upload(p, form) {
      const res = await fetch(s.url + p, { method: 'POST', body: form });
      return { status: res.status, body: await res.json() };
    },
    async del(p) {
      const res = await fetch(s.url + p, { method: 'DELETE' });
      return { status: res.status, body: await res.json() };
    }
  };

  try {
    return await fn(ctx);
  } finally {
    await s.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** 读取 demo 图片并包成 FormData（模拟浏览器上传） */
export async function imageForm(fileName, fields = {}) {
  const buf = await fsp.readFile(path.join(REPO_ROOT, 'sample_data/images', fileName));
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/png' }), fileName);
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return { form, buf };
}

/** demo 图片的 sha256，用来核对夹具是否与图片同步 */
export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
