// The build queue. Builds run one at a time (each already uses every CPU and
// the hardware encoder's sessions), in the order they were asked for. Every
// change to a job is published to listeners, which the SSE endpoint streams
// to the browser.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

const KEEP_FINISHED = 30;
const LOG_LINES = 400;

/**
 * @typedef {'queued'|'running'|'done'|'failed'|'cancelled'} JobState
 * @typedef {{ name: string, total: number, done: number, cached: number, startedAt: number, endedAt: number|null }} PhaseState
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} project
 * @property {'build'|'dry-run'} kind
 * @property {{ rebuild?: boolean }} options
 * @property {JobState} state
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} endedAt
 * @property {PhaseState[]} phases
 * @property {string[]} log
 * @property {any} report     the build report when done
 * @property {string|null} error
 * @property {Array<{ path: string, message: string }>} issues  scene problems that stopped the build
 */

/**
 * @typedef {(job: Job, ctx: { signal: AbortSignal, progress: ReturnType<typeof import('@videomap/builder').createProgress> }) => Promise<any>} Runner
 */

export class JobQueue extends EventEmitter {
  /** @param {Runner} runner */
  constructor(runner) {
    super();
    this.runner = runner;
    /** @type {Job[]} */
    this.jobs = [];
    /** @type {Map<string, AbortController>} */
    this.controllers = new Map();
    this.running = false;
  }

  /**
   * @param {{ project: string, kind: 'build'|'dry-run', options?: { rebuild?: boolean } }} o
   */
  add({ project, kind, options = {} }) {
    /** @type {Job} */
    const job = {
      id: randomBytes(6).toString('hex'),
      project,
      kind,
      options,
      state: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      phases: [],
      log: [],
      report: null,
      error: null,
      issues: [],
    };
    this.jobs.push(job);
    this.trim();
    this.changed(job);
    this.next();
    return job;
  }

  /** @param {string} id */
  get(id) {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  /** Jobs of a project that haven't finished. @param {string} project */
  active(project) {
    return this.jobs.filter((j) => j.project === project && (j.state === 'queued' || j.state === 'running'));
  }

  /** @param {string} id @returns {boolean} whether there was something to cancel */
  cancel(id) {
    const job = this.get(id);
    if (!job) return false;
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.endedAt = Date.now();
      this.changed(job);
      return true;
    }
    if (job.state === 'running') {
      this.controllers.get(id)?.abort();
      return true;
    }
    return false;
  }

  /** Summaries for the job list (the log is long; it streams separately). */
  list() {
    return this.jobs.map(summary);
  }

  async next() {
    if (this.running) return;
    const job = this.jobs.find((j) => j.state === 'queued');
    if (!job) return;
    this.running = true;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.state = 'running';
    job.startedAt = Date.now();
    this.changed(job);
    try {
      job.report = await this.runner(job, { signal: controller.signal, progress: this.progressFor(job) });
      job.state = 'done';
    } catch (err) {
      if (controller.signal.aborted) {
        job.state = 'cancelled';
      } else {
        job.state = 'failed';
        job.error = err.message;
        job.issues = err.issues ?? [];
      }
    } finally {
      job.endedAt = Date.now();
      for (const p of job.phases) p.endedAt ??= job.endedAt;
      this.controllers.delete(job.id);
      this.running = false;
      this.changed(job);
      this.next();
    }
  }

  /**
   * The builder's progress interface, recorded on the job.
   * @param {Job} job
   * @returns {ReturnType<typeof import('@videomap/builder').createProgress>}
   */
  progressFor(job) {
    return {
      phase: (name, total) => {
        /** @type {PhaseState} */
        const p = { name, total, done: 0, cached: 0, startedAt: Date.now(), endedAt: null };
        job.phases.push(p);
        this.changed(job);
        return {
          tick: (cached = false) => {
            p.done++;
            if (cached) p.cached++;
            this.changed(job);
          },
          end: () => {
            if (p.endedAt) return;
            p.endedAt = Date.now();
            this.log(job, `${name}: ${p.done}/${p.total}${p.cached ? ` (${p.cached} cached)` : ''} in ${((p.endedAt - p.startedAt) / 1000).toFixed(1)}s`);
          },
        };
      },
      log: (msg) => this.log(job, msg),
      close: () => {},
    };
  }

  /** @param {Job} job @param {string} line */
  log(job, line) {
    job.log.push(line);
    if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
    this.emit('log', job, line);
    this.changed(job);
  }

  /** @param {Job} job */
  changed(job) {
    this.emit('change', job);
  }

  /** Forget the oldest finished jobs. */
  trim() {
    const finished = this.jobs.filter((j) => j.state !== 'queued' && j.state !== 'running');
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.jobs.splice(this.jobs.indexOf(j), 1);
    }
  }
}

/** @param {Job} job */
export function summary(job) {
  const { log, ...rest } = job;
  return { ...rest, logLength: log.length };
}
