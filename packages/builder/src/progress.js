// Progress reporting: one live status line on a TTY, plain lines otherwise.

/**
 * @typedef {object} Phase
 * @property {(cached?: boolean) => void} tick
 * @property {() => void} end
 */

/**
 * @typedef {object} Progress
 * @property {(name: string, total: number) => Phase} phase
 * @property {(msg: string) => void} log
 * @property {() => void} close
 */

/**
 * @param {{ mode?: 'auto'|'tty'|'plain'|'silent', stream?: NodeJS.WriteStream }} [opts]
 * @returns {Progress}
 */
export function createProgress({ mode = 'auto', stream = process.stderr } = {}) {
  if (mode === 'silent') {
    return { phase: () => ({ tick() {}, end() {} }), log() {}, close() {} };
  }
  const tty = mode === 'tty' || (mode === 'auto' && Boolean(stream.isTTY));
  /** @type {Array<{ name: string, total: number, done: number, cached: number, started: number, ended: boolean }>} */
  const phases = [];
  let timer = null;
  let lineShown = false;

  const render = () => {
    const active = phases.filter((p) => !p.ended);
    if (!active.length) return;
    const text = active.map((p) => `${p.name} ${p.done}/${p.total}${p.cached ? ` (${p.cached} cached)` : ''}${eta(p)}`).join('  ·  ');
    stream.write(`\r\x1b[K${text}`);
    lineShown = true;
  };
  const clearLine = () => {
    if (tty && lineShown) {
      stream.write('\r\x1b[K');
      lineShown = false;
    }
  };

  return {
    phase(name, total) {
      const p = { name, total, done: 0, cached: 0, started: Date.now(), ended: false };
      phases.push(p);
      if (tty && !timer) timer = setInterval(render, 200);
      let lastQuarter = 0;
      return {
        tick(cached = false) {
          p.done++;
          if (cached) p.cached++;
          // Without a live status line (CI, log files), report every quarter of long phases.
          const quarter = Math.floor((p.done / p.total) * 4);
          if (!tty && p.total >= 20 && quarter > lastQuarter && p.done < p.total) {
            lastQuarter = quarter;
            stream.write(`${name}: ${p.done}/${p.total}${eta(p)}\n`);
          }
        },
        end() {
          if (p.ended) return;
          p.ended = true;
          clearLine();
          const secs = ((Date.now() - p.started) / 1000).toFixed(1);
          stream.write(`${name}: ${p.done}/${p.total}${p.cached ? ` (${p.cached} cached)` : ''} in ${secs}s\n`);
          if (tty) render();
        },
      };
    },
    log(msg) {
      clearLine();
      stream.write(`${msg}\n`);
      if (tty) render();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      clearLine();
    },
  };
}

function eta(p) {
  const fresh = p.done - p.cached;
  const remaining = p.total - p.done;
  if (fresh < 2 || !remaining) return '';
  const perJob = (Date.now() - p.started) / fresh;
  return ` ~${formatDuration((perJob * remaining) / 1000)}`;
}

/** @param {number} secs */
export function formatDuration(secs) {
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m${String(Math.round(secs % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Run async jobs with at most `n` in flight. After the first failure, queued jobs are rejected.
 * @param {number} n
 */
export function createLimiter(n) {
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];
  let failure = null;
  const next = () => {
    if (active < n && queue.length) queue.shift()();
  };
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push(async () => {
        if (failure) {
          reject(failure);
          next();
          return;
        }
        active++;
        try {
          resolve(await fn());
        } catch (err) {
          failure ??= err;
          reject(err);
        } finally {
          active--;
          next();
        }
      });
      next();
    });
  };
}
