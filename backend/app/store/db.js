/**
 * JSON 文件存储（零依赖）。
 *
 * 并发策略：所有写操作串行进入一条 Promise 队列，避免同一进程内的读改写竞态。
 * 落盘策略：先写 .tmp 再 rename，保证不会因为进程中断留下半个 JSON 文件。
 *
 * 为什么不用 SQLite：本项目要求「双击 html 就能跑」的轻量场景，
 * Node 22 的内置 sqlite 仍是实验特性，引入 better-sqlite3 又要编译原生模块。
 * JSON 文件在课程演示的数据量级（几十条提交）下完全够用，
 * 迁移脚本的写法也刻意对齐了 SQL 的 add column / backfill 语义，便于日后平移。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { runMigrations, LATEST_SCHEMA_VERSION } from './migrations.js';

let db = null;
let queue = Promise.resolve();
// 当前实际使用的数据库文件：可能被测试用临时目录覆盖，落盘时必须用这个而不是 config 默认值
let activeDbFile = null;
// 最后一次与磁盘同步时文件的 mtime：用于发现「别的进程改了库」（例如 npm run seed）
let lastMtimeMs = 0;
let lastMigration = { from: 0, to: 0, applied: [] };

/** 初始化：确保目录存在、数据库文件存在、迁移已执行 */
export async function initStore(overrides = {}) {
  const dbFile = overrides.dbFile || config.dbFile;
  const dataDir = overrides.dataDir || config.dataDir;
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(overrides.uploadDir || config.uploadDir, { recursive: true });

  // 关键：无论文件是否存在，都要用「本次指定的文件」重建内存态，
  // 否则在同一进程里连续初始化不同库时，会残留上一个库的数据（测试串数据就是这么来的）。
  let loaded = null;
  if (fs.existsSync(dbFile)) {
    const raw = await fsp.readFile(dbFile, 'utf8');
    loaded = raw.trim() ? JSON.parse(raw) : null;
  }
  db = loaded || { schema_version: 0, created_at: new Date().toISOString(), students: {}, submissions: {} };
  activeDbFile = dbFile;
  lastMtimeMs = fs.existsSync(dbFile) ? fs.statSync(dbFile).mtimeMs : 0;
  lastMigration = runMigrations(db);
  await persist();
  return getStoreInfo();
}

function persist() {
  const target = activeDbFile || config.dbFile;
  const tmp = `${target}.tmp`;
  return fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8').then(async () => {
    await fsp.rename(tmp, target);
    // 记录本次落盘的 mtime，避免下一次操作把自己刚写的内容又当成外部修改
    lastMtimeMs = fs.statSync(target).mtimeMs;
  });
}

/**
 * 发现磁盘上的库比内存新时重新加载。
 *
 * 为什么需要：seed 脚本、另一个终端里的管理脚本都是独立进程，
 * 它们写入后运行中的服务必须能看到，否则下一次写入会把对方的数据覆盖掉
 * （课堂演示里「先 npm start 再 npm run seed」正是这个场景）。
 * 代价是每次读写多一次 stat，数据量在演示规模下可忽略。
 */
export function refreshIfStale() {
  if (!activeDbFile) return false;
  let stat;
  try {
    stat = fs.statSync(activeDbFile);
  } catch {
    return false;
  }
  if (stat.mtimeMs === lastMtimeMs) return false;
  try {
    const raw = fs.readFileSync(activeDbFile, 'utf8');
    db = raw.trim() ? JSON.parse(raw) : db;
    lastMtimeMs = stat.mtimeMs;
    return true;
  } catch {
    return false;   // 文件正在被写（半截 JSON）时保持旧内存态，下次再试
  }
}

/** 串行化写操作：mutate 内部可放心做「读当前状态 -> 修改 -> 落盘」 */
export function mutate(fn) {
  const next = queue.then(async () => {
    refreshIfStale();
    const result = await fn(db);
    db.updated_at = new Date().toISOString();
    await persist();
    return result;
  });
  // 即使本次失败也要让队列继续，否则后续写操作全部卡死
  queue = next.catch(() => {});
  return next;
}

export function getStoreInfo() {
  return {
    schema_version: db?.schema_version ?? LATEST_SCHEMA_VERSION,
    submissions: Object.keys(db?.submissions || {}).length,
    students: Object.keys(db?.students || {}).length,
    migration: lastMigration
  };
}

/* ------------------------------------------------------------------ */
/* 提交（submission）仓储                                             */
/* ------------------------------------------------------------------ */

export function newSubmissionId() {
  return 'sub_' + crypto.randomBytes(6).toString('hex');
}

export function getSubmission(id) {
  refreshIfStale();
  return db.submissions[id] || null;
}

export function saveSubmission(sub) {
  return mutate(state => {
    state.submissions[sub.id] = sub;
    if (sub.student_id) {
      const stu = (state.students[sub.student_id] ??= {
        id: sub.student_id,
        created_at: sub.created_at,
        submissions: 0,
        exam_keys: {}
      });
      stu.submissions = (stu.submissions || 0) + 1;
      stu.exam_keys ??= {};
      if (sub.exam_key) stu.exam_keys[sub.exam_key] = (stu.exam_keys[sub.exam_key] || 0) + 1;
      stu.last_submission_at = sub.created_at;
      const list = ((state.index ??= { by_student: {} }).by_student[sub.student_id] ??= []);
      if (!list.includes(sub.id)) list.push(sub.id);
    }
    return sub;
  });
}

/** 按学生取提交，默认按时间升序（趋势图的自然顺序） */
export function listByStudent(studentId, { order = 'asc' } = {}) {
  refreshIfStale();
  const ids = db.index?.by_student?.[studentId] || [];
  const list = ids
    .map(id => db.submissions[id])
    .filter(Boolean)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return order === 'desc' ? list.reverse() : list;
}

export function getStudent(studentId) {
  refreshIfStale();
  return db.students[studentId] || null;
}

export function listStudents() {
  refreshIfStale();
  return Object.values(db.students || {}).sort(
    (a, b) => new Date(b.last_submission_at || 0) - new Date(a.last_submission_at || 0)
  );
}

/** 隐私：按学号彻底删除（含上传的原图引用），用于「被遗忘权」演示 */
export function deleteStudent(studentId) {
  return mutate(state => {
    const ids = state.index?.by_student?.[studentId] || [];
    const removedAssets = [];
    for (const id of ids) {
      const sub = state.submissions[id];
      if (!sub) continue;
      for (const asset of sub.assets || []) if (asset.path) removedAssets.push(asset.path);
      delete state.submissions[id];
    }
    delete state.index?.by_student?.[studentId];
    delete state.students[studentId];
    return { removed_submissions: ids.length, removed_assets: removedAssets };
  });
}

/** 仅供测试：重置内存态 */
export function _resetForTests() {
  db = null;
  activeDbFile = null;
  queue = Promise.resolve();
}

export function _dbPath() {
  return activeDbFile || config.dbFile;
}
