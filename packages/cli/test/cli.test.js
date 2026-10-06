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
    // Hardware detection results go to a throwaway cache, not the user's.
    const env = { ...process.env, NO_COLOR: '1', VMAP_HW_CACHE: path.join(cwd, '.hw-cache.json') };
    execFile(process.execPath, [CLI, ...args], { cwd, env }, (err, stdout, stderr) => {
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
    assert.deepEqual(report.layout.cell, { w: 128, h: 72 });
    assert.equal(report.layout.pack, 'grid');
    assert.equal(report.jobs, null);
    assert.ok(report.estimate.withMedia > report.estimate.withoutMedia);

    const masonry = JSON.parse((await vmap(['build', 'scene.json', '--dry-run', '--json', '--pack', 'masonry', '--column-width', '160', '--gap', '4', '--hw', 'off'], dir)).stdout);
    assert.deepEqual([masonry.layout.pack, masonry.layout.columnWidth, masonry.layout.gap], ['masonry', 160, 4]);
    assert.equal(masonry.encoder.h264, 'libx264');
    assert.equal(masonry.encoder.setting, 'off');

    const text = await vmap(['build', 'scene.json', '--dry-run', '--no-full', '--hw', 'off'], dir);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Encoder\s+libx264/);
    assert.match(text.stdout, /full renditions would add/);
  });

  it('rejects unknown packing and hardware values', async () => {
    assert.match((await vmap(['build', 'scene.json', '--pack', 'pile'], dir)).stderr, /--pack must be grid or masonry/);
    assert.match((await vmap(['build', 'scene.json', '--hw', 'gpu'], dir)).stderr, /--hw must be auto, off, nvenc/);
    assert.equal((await vmap(['build', 'scene.json', '--hw-jobs', '0'], dir)).code, 2);
  });

  it('clean deletes a build cache and leaves anything else alone', async () => {
    const work = path.join(dir, 'cleanme');
    await mkdir(path.join(work, '.vmap-cache', 'clips'), { recursive: true });
    await writeFile(path.join(work, '.vmap-cache', 'clips', 'x.mp4'), Buffer.alloc(1000));
    await writeFile(path.join(work, '.vmap-cache', 'probes.json'), '{}');
    await writeFile(path.join(work, 'scene.json'), '{}');
    const r = await vmap(['clean', 'scene.json'], work);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Deleted .*vmap-cache/);
    assert.match((await vmap(['clean'], work)).stdout, /No build cache/);
    const other = path.join(work, 'notcache');
    await mkdir(other);
    await writeFile(path.join(other, 'keep.txt'), 'x');
    const refused = await vmap(['clean', '--cache', 'notcache'], work);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /doesn't look like a vmap build cache/);
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
