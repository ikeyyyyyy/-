/**
 * multipart/form-data 解析（只做本项目需要的子集：文本字段 + 单个/多个文件字段）。
 *
 * 为什么手写：multer/busboy 会引入依赖，而前端只用 FormData 传一个文件 + 几个字符串。
 * 解析策略：按 boundary 切块，每块按第一个空行切成「头 / 体」，体内保持原始二进制。
 * 注意：不做嵌套 multipart（RFC 2231 的 filename* 编码也暂不支持，中文文件名会退化为原始字节）。
 */

export function getBoundary(contentType = '') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  return (m[1] || m[2] || '').trim();
}

/**
 * @param {Buffer} buffer 整个请求体
 * @param {string} boundary
 * @returns {Array<{name:string|null, filename:string|null, contentType:string|null, data:Buffer}>}
 */
export function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) return parts;

  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    // 结束标记 --boundary--
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;

    let end = next;
    // 去掉分隔符前的 CRLF
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;

    const chunk = buffer.subarray(start, end);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = chunk.subarray(0, headerEnd).toString('utf8');
      const data = chunk.subarray(headerEnd + 4);
      const headers = {};
      for (const line of headerText.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      const disposition = headers['content-disposition'] || '';
      const nameMatch = /name="([^"]*)"/i.exec(disposition);
      const fileMatch = /filename="([^"]*)"/i.exec(disposition);
      parts.push({
        name: nameMatch ? nameMatch[1] : null,
        filename: fileMatch ? decodeFilename(fileMatch[1]) : null,
        contentType: headers['content-type'] || null,
        data
      });
    }
    cursor = next;
  }
  return parts;
}

/** 中文文件名在 multipart 里是 UTF-8 字节被当 latin1 读进来的，这里还原一次 */
function decodeFilename(name) {
  if (!name) return name;
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  try {
    const restored = Buffer.from(name, 'latin1').toString('utf8');
    return restored.includes('\ufffd') ? name : restored;
  } catch {
    return name;
  }
}

/** 把 parts 归并成 { fields: {name: string}, files: {name: FilePart} } */
export function normalizeParts(parts) {
  const fields = {};
  const files = {};
  for (const p of parts) {
    if (!p.name) continue;
    if (p.filename !== null) {
      const existing = files[p.name];
      if (existing) {
        if (Array.isArray(existing)) existing.push(p);
        else files[p.name] = [existing, p];
      } else {
        files[p.name] = p;
      }
    } else {
      fields[p.name] = p.data.toString('utf8');
    }
  }
  return { fields, files };
}
