import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../src/server.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const execFileP = promisify(execFile);
const hasFfmpeg = await execFileP('ffmpeg', ['-version']).then(() => true, () => false);

/** Run vmap and resolve with { code, stdout, stderr } whatever the exit code. */
function vmap(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('vmap CLI', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-cli-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('prints help and rejects unknown commands with exit code 2', async () => {
    const help = await vmap(['--help'], dir);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /vmap build <scene.json>/);
    assert.match((await vmap(['build', '--help'], dir)).stdout, /--preview-duration/);
    const bad = await vmap(['frobnicate'], dir);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Unknown command/);
    assert.equal((await vmap(['build', 'scene.json', '--fps', 'fast'], dir)).code, 2);
  });

  it('validate reports schema errors and missing files', async () => {
    await writeFile(path.join(dir, 'bad.json'), JSON.stringify({ layout: { fit: 'squash' }, videos: [{ src: 'missing.mp4' }] }));
    const r = await vmap(['validate', 'bad.json'], dir);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /layout\.fit: must be one of/);

    await writeFile(path.join(dir, 'missing.json'), JSON.stringify({ videos: [{ src: 'missing.mp4' }] }));
    const m = await vmap(['validate', 'missing.json', '--json'], dir);
    assert.equal(m.code, 2);
    assert.deepEqual(JSON.parse(m.stdout).errors, ['videos[0].src: file not found: missing.mp4']);
  });

  it('init scaffolds a scene with folder categories', async () => {
    const lib = path.join(dir, 'library');
    await mkdir(path.join(lib, 'Ocean Life'), { recursive: true });
    await writeFile(path.join(lib, 'Ocean Life', 'coral_reef.mp4'), '');
    await writeFile(path.join(lib, 'intro.MOV'), '');
    await writeFile(path.join(lib, 'notes.txt'), '');
    const r = await vmap(['init', 'library', '-o', 'lib.json'], dir);
    assert.equal(r.code, 0, r.stderr);
    const scene = JSON.parse(await readFile(path.join(dir, 'lib.json'), 'utf8'));
    assert.deepEqual(scene.categories, [{ id: 'ocean-life', label: 'Ocean Life' }]);
    assert.deepEqual(scene.videos.map((v) => [v.id, v.src, v.title, v.categories]), [
      ['intro', 'library/intro.MOV', 'Intro', undefined],
      ['coral-reef', 'library/Ocean Life/coral_reef.mp4', 'Coral reef', ['ocean-life']],
    ]);
    assert.equal((await vmap(['init', 'library', '-o', 'lib.json'], dir)).code, 2, 'refuses to overwrite');
  });

  it('build --dry-run --json prints a plan', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 60_000 }, async () => {
    await execFileP('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'clip.mp4')]);
    await writeFile(path.join(dir, 'scene.json'), JSON.stringify({ videos: [{ src: 'clip.mp4' }, { src: 'clip.mp4', id: 'again' }] }));
    const r = await vmap(['build', 'scene.json', '--dry-run', '--json', '--cell', '128x72', '--tile', '256x144'], dir);
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.videos, 2);
    assert.deepEqual(report.cell, { w: 128, h: 72 });
    assert.equal(report.jobs, null);
  });
});

describe('preview server', () => {
  let dir;
  let server;
  let base;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-serve-'));
    await writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
    await writeFile(path.join(dir, 'clip.mp4'), Buffer.from('0123456789'));
    ({ server } = await startServer({ root: dir, port: 0, host: '127.0.0.1' }));
    const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves index.html for folders and supports range requests', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await index.text(), '<h1>hi</h1>');

    const part = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');

    const tail = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=-3' } });
    assert.equal(await tail.text(), '789');
    assert.equal((await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=20-' } })).status, 416);
  });

  it('does not serve files outside the root', async () => {
    const r = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    assert.ok(r.status === 403 || r.status === 404);
    assert.equal((await fetch(`${base}/nope.txt`)).status, 404);
  });
});
