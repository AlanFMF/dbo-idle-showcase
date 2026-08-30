import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const legacyConfigDir = path.resolve(here, '../config');
export const externalConfigDir = process.env.DBO_IDLE_CONFIG_DIR
  ? path.resolve(process.env.DBO_IDLE_CONFIG_DIR)
  : (process.platform === 'win32' ? 'C:\\DBO-IDLE-CONFIG' : legacyConfigDir);

export function configCandidates(fileName) {
  const preferred = path.join(externalConfigDir, fileName);
  const legacy = path.join(legacyConfigDir, fileName);
  return preferred === legacy ? [preferred] : [preferred, legacy];
}

export function resolvePrivateConfig(fileName) {
  for (const candidate of configCandidates(fileName)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(externalConfigDir, fileName);
}

export function preferredPrivateConfig(fileName) {
  return path.join(externalConfigDir, fileName);
}
