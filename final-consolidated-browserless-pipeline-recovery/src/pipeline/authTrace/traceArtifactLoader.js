import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function loadTracePairs(dir, overrides = {}) {
  if (overrides.overrideRequests) {
    return overrides.overrideRequests.map((req, i) => {
      const res = overrides.overrideResponses?.[i] ?? null;
      return { id: i + 1, request: req, response: res };
    });
  }

  const reqDir = path.join(dir, 'requests');
  const resDir = path.join(dir, 'responses');

  const reqFiles = (await readdir(reqDir)).filter((f) => f.startsWith('request-') && f.endsWith('.json'));
  const resFiles = (await readdir(resDir)).filter((f) => f.startsWith('response-') && f.endsWith('.json'));

  const ids = reqFiles
    .map((f) => parseInt(f.replace('request-', '').replace('.json', ''), 10))
    .sort((a, b) => a - b);

  const requests = await Promise.all(ids.map(async (id) => ({
    id,
    request: JSON.parse(await readFile(path.join(reqDir, `request-${id}.json`), 'utf8')),
  })));

  const responses = await Promise.all(
    resFiles
      .map((f) => parseInt(f.replace('response-', '').replace('.json', ''), 10))
      .sort((a, b) => a - b)
      .map(async (id) => JSON.parse(await readFile(path.join(resDir, `response-${id}.json`), 'utf8'))),
  );

  const usedResponseIndexes = new Set();

  return requests.map(({ id, request }) => {
    let matchedIndex = -1;
    let bestTs = Number.POSITIVE_INFINITY;

    for (let i = 0; i < responses.length; i++) {
      if (usedResponseIndexes.has(i)) continue;
      const response = responses[i];
      if (response.url !== request.url) continue;
      if ((response.ts ?? 0) < (request.ts ?? 0)) continue;
      if ((response.ts ?? 0) < bestTs) {
        bestTs = response.ts ?? 0;
        matchedIndex = i;
      }
    }

    const response = matchedIndex >= 0 ? responses[matchedIndex] : null;
    if (matchedIndex >= 0) usedResponseIndexes.add(matchedIndex);
    return { id, request, response };
  });
}

export async function loadCookieDiffs(dir) {
  const diffDir = path.join(dir, 'cookie-diffs');
  let files = [];
  try {
    files = await readdir(diffDir);
  } catch {
    return {};
  }
  const result = {};
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const name = f.replace('.json', '');
    result[name] = JSON.parse(await readFile(path.join(diffDir, f), 'utf8'));
  }
  return result;
}

export async function loadCheckpoints(dir) {
  const cpDir = path.join(dir, 'checkpoints');
  let files = [];
  try {
    files = await readdir(cpDir);
  } catch {
    return [];
  }
  const checkpoints = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const cp = JSON.parse(await readFile(path.join(cpDir, f), 'utf8'));
    checkpoints.push(cp);
  }
  return checkpoints.sort((a, b) => (a.ts ?? 0) < (b.ts ?? 0) ? -1 : 1);
}
