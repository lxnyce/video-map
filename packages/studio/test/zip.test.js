import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { planZip, zipStream } from '../src/server/zip.js';
import { readZip } from './zip-reader.js';

const run = promisify(execFile);
const hasUnzip = await run('unzip', ['-v']).then(() => true, () => false);

describe('zip export', () => {
  let dir;
  let files;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-zip-'));
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
    files = [
      { name: 'wall/index.html', data: Buffer.from('<!doctype html><title>x</title>') },
      { name: 'wall/tiles/0/0/0.mp4', data: big },
      { name: 'wall/posters/café.webp', data: Buffer.from('poster') },
      { name: 'wall/empty.txt', data: Buffer.alloc(0) },
    ];
    for (const [i, f] of files.entries()) await writeFile(path.join(dir, `f${i}`), f.data);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const entries = () => files.map((f, i) => ({ name: f.name, file: path.join(dir, `f${i}`), size: f.data.length, mtime: new Date(2026, 9, 6, 12, 30) }));

  async function write(opts, name) {
    const out = path.join(dir, name);
    const { stream, size } = zipStream(entries(), opts);
    await pipeline(stream, createWriteStream(out));
    const buf = await readFile(out);
    assert.equal(buf.length, size, 'the planned size is the real size (Content-Length)');
    return { out, buf };
  }

  it('writes stored entries with sizes known up front', async () => {
    const { out, buf } = await write(undefined, 'plain.zip');
    const zip = readZip(buf);
    assert.equal(zip.zip64, false);
    assert.deepEqual(zip.entries.map((e) => e.name), files.map((f) => f.name));
    zip.entries.forEach((e, i) => assert.ok(e.data.equals(files[i].data)));
    if (hasUnzip) {
      const { stdout } = await run('unzip', ['-t', out]);
      assert.match(stdout, /No errors detected/);
    }
  });

  it('adds ZIP64 records past the 32-bit limits', async () => {
    // A low threshold stands in for 4 GB: the big file, later offsets and the directory all overflow.
    const { out, buf } = await write({ zip64Threshold: 1000 }, 'zip64.zip');
    const zip = readZip(buf);
    assert.equal(zip.zip64, true);
    zip.entries.forEach((e, i) => assert.ok(e.data.equals(files[i].data), e.name));
    assert.ok(planZip(entries(), { zip64Threshold: 1000 }).items[1].zip64);
    if (hasUnzip) {
      // unzip checks the records' layout but not our scaled-down limit, so only a successful listing is asserted.
      const { stdout } = await run('unzip', ['-l', out]);
      assert.match(stdout, /tiles\/0\/0\/0\.mp4/);
    }
  });

  it('fails when a file changes while zipping', async () => {
    const list = entries();
    list[0].size += 5;
    const { stream } = zipStream(list);
    await assert.rejects(pipeline(stream, createWriteStream(path.join(dir, 'bad.zip'))), /changed while it was being zipped/);
  });
});
