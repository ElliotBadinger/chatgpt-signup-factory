import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeDetailedArtifact(dir, id, payload) {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.json`);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}
