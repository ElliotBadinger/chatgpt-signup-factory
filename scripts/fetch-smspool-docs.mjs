#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE_PAGE = 'https://documenter.getpostman.com/view/30155063/2s9YXmZ1JY';
const SOURCE_API =
  'https://documenter.gw.postman.com/api/collections/30155063/2s9YXmZ1JY?segregateAuth=true&versionTag=latest';

const OUT_DIR = resolve('docs/vendor-api');
const MARKDOWN_OUT = resolve(OUT_DIR, 'smspool.md');
const RAW_OUT = resolve(OUT_DIR, 'smspool.postman.json');

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripHtml(value) {
  return normalizeWhitespace(
    String(value ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/(div|section|article|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

function escapeTableCell(value) {
  return stripHtml(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function formatUrl(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (url.raw) return url.raw;

  const protocol = url.protocol ?? 'https';
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host;
  const path = Array.isArray(url.path) ? url.path.join('/') : url.path;
  const activeQuery = Array.isArray(url.query) ? url.query.filter((item) => !item.disabled) : [];
  const query = activeQuery
    .map((item) => `${item.key ?? ''}=${item.value ?? ''}`)
    .filter((item) => item !== '=')
    .join('&');

  let built = `${protocol}://${host ?? ''}`;
  if (path) built += `/${path}`;
  if (query) built += `?${query}`;
  return built;
}

function renderAuth(auth) {
  if (!auth) return [];
  const lines = ['#### Auth', '', `- Type: \`${auth.type ?? 'unknown'}\``];
  if (auth.type === 'bearer') lines.push('- Token field: `token`');
  return [...lines, ''];
}

function renderParams(title, params) {
  const active = Array.isArray(params) ? params.filter((param) => !param.disabled) : [];
  if (active.length === 0) return [];

  const lines = [heading(4, title), '', '| Name | Value | Description |', '| --- | --- | --- |'];
  for (const param of active) {
    lines.push(
      `| \`${param.key ?? ''}\` | \`${escapeTableCell(param.value ?? '')}\` | ${escapeTableCell(
        param.description ?? ''
      )} |`
    );
  }
  return [...lines, ''];
}

function renderBody(body) {
  if (!body) return [];

  const lines = ['#### Request Body', '', `- Mode: \`${body.mode ?? 'unknown'}\``, ''];
  if (body.mode === 'raw' && body.raw) {
    lines.push('```', normalizeWhitespace(body.raw), '```', '');
  }
  if (body.mode === 'formdata') lines.push(...renderParams('Form Fields', body.formdata));
  if (body.mode === 'urlencoded') lines.push(...renderParams('URL Encoded Fields', body.urlencoded));
  return lines;
}

function renderResponses(responses) {
  if (!Array.isArray(responses) || responses.length === 0) return [];

  const lines = ['#### Responses', ''];
  for (const response of responses) {
    const code = response.code ? `\`${response.code}\` ` : '';
    lines.push(`##### ${code}${response.name ?? ''}`.trim(), '');

    if (response.header?.length) lines.push(...renderParams('Response Headers', response.header));

    const body = normalizeWhitespace(response.body);
    if (body) {
      const lang = body.startsWith('{') || body.startsWith('[') ? 'json' : '';
      lines.push(`\`\`\`${lang}`, body, '```', '');
    }
  }
  return lines;
}

function heading(depth, title) {
  return `${'#'.repeat(depth)} ${title}`;
}

function renderItem(item, depth = 2) {
  const lines = [heading(depth, item.name), ''];
  const description = stripHtml(item.description);
  if (description) lines.push(description, '');

  if (item.request) {
    const request = item.request;
    lines.push(`- Method: \`${request.method ?? 'GET'}\``, `- URL: \`${formatUrl(request.url)}\``, '');
    lines.push(...renderAuth(request.auth));
    lines.push(...renderParams('Headers', request.header));

    const url = request.url;
    if (url && typeof url === 'object') {
      lines.push(...renderParams('Path Variables', url.variable));
      lines.push(...renderParams('Query Parameters', url.query));
    }

    lines.push(...renderBody(request.body));
    lines.push(...renderResponses(item.response));
  }

  for (const child of item.item ?? []) {
    lines.push(...renderItem(child, depth + 1));
  }

  return lines;
}

function countRequests(items) {
  let count = 0;
  for (const item of items ?? []) {
    if (item.request) count += 1;
    count += countRequests(item.item);
  }
  return count;
}

function renderMarkdown(collection, fetchedAt) {
  const lines = [
    '# SMSPool API Docs',
    '',
    `Source page: ${SOURCE_PAGE}`,
    `Source API: ${SOURCE_API}`,
    `Fetched: ${fetchedAt}`,
    `Request count: ${countRequests(collection.item)}`,
    '',
  ];

  const description = stripHtml(collection.info?.description);
  if (description) lines.push(description, '');

  lines.push(...renderAuth(collection.auth));
  lines.push(...renderParams('Variables', collection.variable));

  for (const item of collection.item ?? []) {
    lines.push(...renderItem(item));
  }

  return `${normalizeWhitespace(lines.join('\n'))}\n`;
}

async function fetchCollection() {
  const response = await fetch(SOURCE_API, {
    headers: {
      accept: 'application/json',
      'user-agent': 'codex-doc-fetcher/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`SMSPool Postman collection fetch failed: HTTP ${response.status}`);
  }
  return response.json();
}

const collection = await fetchCollection();
const fetchedAt = new Date().toISOString();

await mkdir(OUT_DIR, { recursive: true });
await Promise.all([
  writeFile(RAW_OUT, `${JSON.stringify(collection, null, 2)}\n`, 'utf8'),
  writeFile(MARKDOWN_OUT, renderMarkdown(collection, fetchedAt), 'utf8'),
]);

console.log(`Wrote ${MARKDOWN_OUT}`);
console.log(`Wrote ${RAW_OUT}`);
console.log(`Rendered ${countRequests(collection.item)} SMSPool requests from ${SOURCE_API}`);
