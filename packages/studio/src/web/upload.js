// A small tus 1.0 client: uploads in chunks with progress, resumes after a
// dropped connection or a page reload (the upload URL is remembered per file),
// and retries with backoff.

const CHUNK = 8 * 1024 * 1024;
const RETRIES = [1000, 3000, 6000, 12000, 20000];
const TUS = { 'Tus-Resumable': '1.0.0' };

/**
 * @typedef {object} UploadItem
 * @property {string} key
 * @property {File} file
 * @property {string} name
 * @property {number} size
 * @property {number} sent
 * @property {'queued'|'uploading'|'processing'|'done'|'error'|'cancelled'} state
 * @property {string} [error]
 * @property {string} [src]  scene path once done
 */

/**
 * @param {object} o
 * @param {string} o.endpoint  e.g. /api/projects/<id>/uploads
 * @param {string} o.scope     part of the resume key (the project id)
 * @param {(items: UploadItem[]) => void} o.onChange
 * @param {(item: UploadItem) => void} o.onDone
 * @param {number} [o.parallel]
 */
export function createUploader({ endpoint, scope, onChange, onDone, parallel = 2 }) {
  /** @type {UploadItem[]} */
  let items = [];
  /** @type {Map<string, XMLHttpRequest>} */
  const requests = new Map();
  const changed = () => onChange([...items]);

  function pump() {
    const active = items.filter((i) => i.state === 'uploading' || i.state === 'processing').length;
    const next = items.filter((i) => i.state === 'queued').slice(0, Math.max(0, parallel - active));
    for (const item of next) run(item);
  }

  async function run(item) {
    item.state = 'uploading';
    item.error = undefined;
    changed();
    const storeKey = `vmap-upload:${scope}:${item.name}:${item.size}:${item.file.lastModified}`;
    for (let attempt = 0; ; attempt++) {
      try {
        let url = readStored(storeKey);
        let offset = 0;
        if (url) {
          const head = await fetch(url, { method: 'HEAD', headers: TUS });
          if (head.ok) offset = Number(head.headers.get('Upload-Offset'));
          else url = null;
        }
        if (!url) {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { ...TUS, 'Upload-Length': String(item.size), 'Upload-Metadata': `filename ${b64(item.name)},filetype ${b64(item.file.type || 'video/mp4')}` },
          });
          if (!res.ok) throw new Fatal(await errorText(res));
          url = /** @type {string} */ (res.headers.get('Location'));
          writeStored(storeKey, url);
        }
        item.sent = offset;
        changed();
        while (item.state === 'uploading') {
          const end = Math.min(item.size, offset + CHUNK);
          const last = end === item.size;
          if (last) {
            item.state = 'processing'; // the server probes the file before answering
            changed();
          }
          const res = await patch(item, url, offset, item.file.slice(offset, end));
          if (res.status === 409) {
            offset = Number(res.getResponseHeader('Upload-Offset'));
            if (last) item.state = 'uploading';
            continue;
          }
          if (res.status !== 204) {
            const message = parseError(res.responseText) ?? `Upload failed (${res.status})`;
            if (res.status >= 400 && res.status < 500) {
              removeStored(storeKey);
              throw new Fatal(message);
            }
            throw new Error(message);
          }
          offset = Number(res.getResponseHeader('Upload-Offset'));
          item.sent = offset;
          if (offset >= item.size) {
            const src = res.getResponseHeader('X-Vmap-Src');
            removeStored(storeKey);
            item.src = src ? decodeURIComponent(src) : undefined;
            item.state = 'done';
            changed();
            onDone(item);
            return;
          }
          if (item.state === 'processing') item.state = 'uploading';
          changed();
        }
        return; // cancelled
      } catch (err) {
        if (/** @type {any} */ (item).state === 'cancelled') return;
        if (err instanceof Fatal || attempt >= RETRIES.length) {
          item.state = 'error';
          item.error = err.message;
          changed();
          return;
        }
        item.error = `Connection lost; retrying (${attempt + 1}/${RETRIES.length})…`;
        item.state = 'uploading';
        changed();
        await new Promise((r) => setTimeout(r, RETRIES[attempt]));
      } finally {
        if (item.state !== 'uploading' && item.state !== 'processing') {
          requests.delete(item.key);
          pump();
        }
      }
    }
  }

  /** @returns {Promise<XMLHttpRequest>} */
  function patch(item, url, offset, blob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      requests.set(item.key, xhr);
      xhr.open('PATCH', url);
      xhr.setRequestHeader('Tus-Resumable', '1.0.0');
      xhr.setRequestHeader('Upload-Offset', String(offset));
      xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
      xhr.upload.onprogress = (e) => {
        item.sent = offset + e.loaded;
        changed();
      };
      xhr.onload = () => resolve(xhr);
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(new Error('Cancelled'));
      xhr.send(blob);
    });
  }

  return {
    /** @param {File[]} files */
    add(files) {
      for (const file of files) {
        items.push({ key: `${file.name}|${file.size}|${Math.random().toString(36).slice(2)}`, file, name: file.name, size: file.size, sent: 0, state: 'queued' });
      }
      changed();
      pump();
    },
    /** @param {string} key */
    cancel(key) {
      const item = items.find((i) => i.key === key);
      if (!item || item.state === 'done') return;
      item.state = 'cancelled';
      requests.get(key)?.abort();
      items = items.filter((i) => i !== item);
      changed();
      pump();
    },
    /** @param {string} key */
    retry(key) {
      const item = items.find((i) => i.key === key);
      if (item?.state !== 'error') return;
      item.state = 'queued';
      changed();
      pump();
    },
    /** Forget finished and failed items. */
    clear() {
      items = items.filter((i) => i.state === 'queued' || i.state === 'uploading' || i.state === 'processing');
      changed();
    },
    busy: () => items.some((i) => i.state === 'queued' || i.state === 'uploading' || i.state === 'processing'),
  };
}

class Fatal extends Error {}

function b64(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

async function errorText(res) {
  return parseError(await res.text()) ?? `Upload refused (${res.status})`;
}

function parseError(text) {
  try {
    return JSON.parse(text).error ?? null;
  } catch {
    return null;
  }
}

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // resuming after a reload just won't work
  }
}

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing to clean up
  }
}
