/**
 * 把 Apifox 导出的 Swagger UI HTML 转成 markdown API 文档。
 *
 * 入口 HTML 通常是一个 1-2MB 的 minified 单文件，OpenAPI 3.0.1 spec JSON
 * 嵌在 `<script>window.onload = function() { ... spec: { ... } ... }</script>`
 * 里。这个脚本：
 *   1) 从 HTML 里抠出 spec JSON（用括号匹配定位）
 *   2) 解析成对象
 *   3) 按 tag → path → method 顺序渲染成 markdown
 *
 * 用法：
 *   node scripts/akbot-html-to-md.mjs docs/akbot_api.html docs/akbot_api.md
 *
 * 默认 input/output:
 *   docs/akbot_api.html  ->  docs/akbot_api.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const INPUT  = args[0] || 'docs/akbot_api.html';
const OUTPUT = args[1] || 'docs/akbot_api.md';

/* ---------- 1) 抠 spec JSON ---------- */
const html = readFileSync(resolve(INPUT), 'utf8');
const marker = 'spec: {"openapi"';
const startIdx = html.indexOf(marker);
if (startIdx < 0) {
  throw new Error('找不到 spec JSON —— HTML 格式可能变了');
}
const jsonStart = startIdx + 'spec: '.length;

// 括号配对定位 spec 对象的结束位置
let depth = 0;
let jsonEnd = -1;
for (let i = jsonStart; i < html.length; i++) {
  const c = html[i];
  if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth === 0) { jsonEnd = i + 1; break; }
  }
}
if (jsonEnd < 0) throw new Error('括号配对失败 —— JSON 可能被截断');

const spec = JSON.parse(html.slice(jsonStart, jsonEnd));
console.error(`[akbot-html-to-md] spec extracted, ${jsonEnd - jsonStart} bytes, ${Object.keys(spec.paths || {}).length} paths`);

/* ---------- 2) 渲染 ---------- */
const out = [];
const now = new Date().toISOString().slice(0, 10);
out.push(`# akbot API 文档`);
out.push(``);
out.push(`> 自动从 \`${INPUT}\` 转换（Apifox Swagger UI 导出 → OpenAPI 3.0.1）`);
out.push(`> 基础 URL: \`${spec.servers?.[0]?.url || '(无)'}\``);
out.push(`> 生成日期: ${now}`);
out.push(``);
out.push(`## 鉴权`);
out.push(``);
out.push(`所有接口都通过 \`x-api-key\` 请求头鉴权。`);
out.push(``);
out.push(`| Header | 必填 | 示例 |`);
out.push(`|---|---|---|`);
out.push(`| \`x-api-key\` | 是 | \`oFmk0_Qmuthni7uA2r4I09P352q468vl5nK43HF-HUY\` |`);
out.push(``);

/* ---------- 3) 标签分组渲染 ---------- */

// 收集所有 tag 顺序：spec.tags 里的顺序优先，paths 里出现但未声明的 tag 补到末尾
const declaredTags = (spec.tags || []).map(t => t.name);
const tagsSeen = new Set();
for (const p of Object.keys(spec.paths || {})) {
  for (const m of Object.keys(spec.paths[p])) {
    for (const t of spec.paths[p][m].tags || []) tagsSeen.add(t);
  }
}
const allTags = [...declaredTags, ...[...tagsSeen].filter(t => !declaredTags.includes(t))];

if (allTags.length) {
  out.push(`## 标签分组`);
  out.push(``);
  for (const tag of allTags) {
    out.push(`- \`${tag}\``);
  }
  out.push(``);
}

// 按 tag → path → method 顺序输出
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
const mdEscape = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

out.push(`## 接口列表`);
out.push(``);
for (const tag of allTags) {
  out.push(`### ${tag}`);
  out.push(``);
  for (const [path, pathObj] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = pathObj[method];
      if (!op) continue;
      if (!(op.tags || []).includes(tag)) continue;
      out.push(`#### \`${method.toUpperCase()} ${path}\``);
      out.push(``);
      if (op.summary) { out.push(`**${op.summary}**`); out.push(``); }
      if (op.deprecated) { out.push(`> ⚠️ **已废弃**`); out.push(``); }
      if (op.description && op.description !== op.summary) {
        out.push(op.description);
        out.push(``);
      }

      // Headers (从 parameters 里抽 in: header 的)
      const headers = (op.parameters || []).filter(p => p.in === 'header');
      if (headers.length) {
        out.push(``);
        out.push(`**Headers**`);
        out.push(``);
        out.push(`| 名称 | 必填 | 类型 | 默认 | 说明 |`);
        out.push(`|---|---|---|---|---|`);
        for (const h of headers) {
          // x-api-key 在 apifox 导出的 spec 里没标 required，但实际必填 —— 强制标
          const isRequired = h.required || h.name === 'x-api-key';
          const req = isRequired ? '✓' : '';
          const type = h.schema?.type || '-';
          const def = h.schema?.default !== undefined ? `\`${JSON.stringify(h.schema.default)}\`` : '-';
          out.push(`| \`${h.name}\` | ${req} | ${type} | ${def} | ${mdEscape(h.description || '')} |`);
        }
      }

      // Query / Path
      const queryParams = (op.parameters || []).filter(p => p.in === 'query' || p.in === 'path');
      if (queryParams.length) {
        out.push(``);
        out.push(`**${queryParams[0].in === 'path' ? 'Path 参数' : 'Query 参数'}**`);
        out.push(``);
        out.push(`| 名称 | 位置 | 必填 | 类型 | 默认 | 说明 |`);
        out.push(`|---|---|---|---|---|---|`);
        for (const p of queryParams) {
          const req = p.required ? '✓' : '';
          const type = p.schema?.type || '-';
          const def = p.schema?.default !== undefined ? `\`${JSON.stringify(p.schema.default)}\`` : '-';
          out.push(`| \`${p.name}\` | ${p.in} | ${req} | ${type} | ${def} | ${mdEscape(p.description || '')} |`);
        }
      }

      // Request body
      if (op.requestBody) {
        const json = op.requestBody.content?.['application/json'];
        if (json) {
          out.push(``);
          out.push(`**Request Body** (application/json)`);
          out.push(``);
          if (json.schema?.$ref) {
            out.push(`Schema: ${json.schema.$ref.replace('#/components/schemas/', '`')}\``);
          } else if (json.schema) {
            out.push(`Schema: \`inline\``);
          }
          if (json.example) {
            out.push(``);
            out.push(`Example:`);
            out.push(``);
            out.push('```json');
            out.push(JSON.stringify(json.example, null, 2));
            out.push('```');
          }
        }
      }

      // Responses
      for (const [code, resp] of Object.entries(op.responses || {})) {
        out.push(``);
        const respTitle = resp.description
          ? `**Response ${code}** — ${resp.description}`
          : `**Response ${code}**`;
        out.push(respTitle);
        const j = resp.content?.['application/json'];
        if (j) {
          if (j.schema?.$ref) {
            out.push(``);
            out.push(`Schema: ${j.schema.$ref.replace('#/components/schemas/', '`')}\``);
          }
          if (j.example) {
            out.push(``);
            out.push('```json');
            out.push(JSON.stringify(j.example, null, 2));
            out.push('```');
          }
        }
      }
      out.push(``);
      out.push(`---`);
      out.push(``);
    }
  }
}

/* ---------- 4) 公共数据模型 ---------- */
out.push(`## 数据模型 (components/schemas)`);
out.push(``);
const schemas = spec.components?.schemas || {};
const sortedSchemaNames = Object.keys(schemas).sort();
for (const name of sortedSchemaNames) {
  const sch = schemas[name];
  out.push(`### \`${name}\``);
  out.push(``);
  if (sch.description) { out.push(`${sch.description}  `); }
  if (sch.type === 'object' || sch.properties) {
    out.push(``);
    out.push(`| 字段 | 类型 | 必填 | 默认 | 范围 | 说明 |`);
    out.push(`|---|---|---|---|---|---|`);
    const required = new Set(sch.required || []);
    for (const [propName, prop] of Object.entries(sch.properties || {})) {
      const isReq = required.has(propName) ? '✓' : '';
      const typeStr = renderType(prop);
      const def = prop.default !== undefined
        ? `\`${mdEscape(JSON.stringify(prop.default))}\``
        : '-';
      const range = [];
      if (prop.minimum !== undefined) range.push(`min=${prop.minimum}`);
      if (prop.maximum !== undefined) range.push(`max=${prop.maximum}`);
      const rangeStr = range.length ? range.join(' ') : '-';
      out.push(`| \`${propName}\` | ${typeStr} | ${isReq} | ${def} | ${rangeStr} | ${mdEscape(prop.description || '')} |`);
    }
  } else if (sch.type) {
    out.push(`类型: \`${sch.type}\`  `);
  }
  if (sch.required?.length) {
    out.push(``);
    out.push(`**必填**: ${sch.required.map(r => `\`${r}\``).join(', ')}`);
  }
  out.push(``);
}

writeFileSync(resolve(OUTPUT), out.join('\n'), 'utf8');
console.error(`[akbot-html-to-md] written to ${OUTPUT}`);

/* ---------- helpers ---------- */
function renderType(prop) {
  if (prop.$ref) {
    return `[${prop.$ref.replace('#/components/schemas/', '')}]`;
  }
  if (prop.type === 'array') {
    const inner = prop.items?.$ref
      ? prop.items.$ref.replace('#/components/schemas/', '')
      : prop.items?.type || 'any';
    return `array<${inner}>`;
  }
  if (prop.type && prop.format) return `${prop.type} (${prop.format})`;
  return prop.type || '-';
}
