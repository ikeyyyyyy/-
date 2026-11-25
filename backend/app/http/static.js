/**
 * 静态文件服务：把仓库根目录的现有页面、新增页面、上传的原图一起托管。
 * 白名单式路由（只暴露必要目录）+ 路径穿越防护（解析后必须仍在根目录内）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, REPO_ROOT } from '../config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon'
};

/** 前缀 -> 物理根目录。prefix 为空表示仓库根 */
const MOUNTS = [
  { prefix: '', root: REPO_ROOT, depth: 1 },                 // /index.html 等根文件
  { prefix: '/assets', root: path.join(REPO_ROOT, 'assets') },
  { prefix: '/frontend', root: path.join(REPO_ROOT, 'frontend') },
  { prefix: '/sample_data', root: path.join(REPO_ROOT, 'sample_data') },
  { prefix: '/docs', root: path.join(REPO_ROOT, 'docs') },
  { prefix: '/uploads', root: config.uploadDir }
];

export function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;                                  // 非法百分号编码
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';

  for (const mount of MOUNTS) {
    if (mount.prefix === '') {
      // 根挂载只允许单层文件（index.html / LICENSE），避免把 backend 源码暴露出去
      if (decoded.split('/').filter(Boolean).length !== 1) continue;
      const target = path.join(mount.root, decoded.replace(/^\/+/, ''));
      if (isInside(mount.root, target) && fs.existsSync(target) && fs.statSync(target).isFile()) {
        return { file: target, mime: MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' };
      }
      continue;
    }
    if (!decoded.startsWith(mount.prefix + '/')) continue;
    const rel = decoded.slice(mount.prefix.length + 1);
    const target = path.join(mount.root, rel);
    if (!isInside(mount.root, target)) continue;   // ../ 穿越直接拒绝
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      return { file: target, mime: MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' };
    }
  }
  return null;
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function serveStatic(req, res, urlPath) {
  const hit = resolveStatic(urlPath);
  if (!hit) return false;
  const data = await fsp.readFile(hit.file);
  res.writeHead(200, {
    'Content-Type': hit.mime,
    'Content-Length': data.length,
    // 演示页面不缓存，避免改完看不到效果；上传的原图可以缓存
    'Cache-Control': urlPath.startsWith('/uploads/') ? 'public, max-age=86400' : 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}
