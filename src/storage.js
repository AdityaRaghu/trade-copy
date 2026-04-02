import fs from 'node:fs';
import path from 'node:path';

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function ensureJsonFile(filePath, initialValue) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      JSON.stringify(initialValue, null, 2)
    );
  }
}

export function readJsonFile(filePath, initialValue) {
  ensureJsonFile(filePath, initialValue);

  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();

    if (!raw) {
      return cloneValue(initialValue);
    }

    return JSON.parse(raw);
  } catch {
    return cloneValue(initialValue);
  }
}

export function writeJsonFile(filePath, value) {
  ensureJsonFile(filePath, value);

  fs.writeFileSync(
    filePath,
    JSON.stringify(value, null, 2)
  );

  return value;
}