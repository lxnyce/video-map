// End-to-end: the Studio in Chromium against a real server and ffmpeg. Creates
// a project, uploads clips, edits them in the forms and in the JSON editor,
// previews the layout, builds, previews the built wall, downloads the zip and
// resolves a save conflict. Skipped without ffmpeg or a Playwright browser.
//
//   npm run test:e2e

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startStudio } from '../src/server/index.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
let chromium = null;
try {
  ({ chromium } = await import('playwright'));
  await (await chromium.launch()).close();
} catch {
  chromium = null;
}
const skip = !hasFfmpeg ? 'ffmpeg not installed' : !chromium ? 'no Playwright browser (npx playwright install chromium)' : false;
const GL_ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

describe('studio (browser)', { skip, timeout: 240_000 }, () => {
  let dir;
  let studio;
  let browser;
  let page;
  const clips = [];
  const errors = [];

  before(async () => {
    // Test the current source, not a stale build of the UI.
    const pkg = fileURLToPath(new URL('..', import.meta.url));
    const { build } = await import('vite');
    await build({ root: pkg, logLevel: 'error' });
    dir = await mkdtemp(path.join(os.tmpdir(), 'vmap-studio-e2e-'));
    process.env.VMAP_HW_CACHE = path.join(dir, 'hw-cache.json');
    for (const [i, size] of ['320x180', '180x320', '240x240'].entries()) {
      const file = path.join(dir, `clip_${i}.mp4`);
      await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=20:d=2`, '-vf', `hue=h=${i * 90}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
      clips.push(file);
    }
    studio = await startStudio({ dataDir: path.join(dir, 'data'), port: 0 });
    // Hardware encoders differ between machines; keep builds on libx264.
    await fetch(`${studio.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hardware: 'off' }) });
    browser = await chromium.launch({ args: GL_ARGS });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', (d) => d.accept());
  });

  after(async () => {
    await browser?.close();
    await studio?.close();
    delete process.env.VMAP_HW_CACHE;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const scenePath = () => path.join(dir, 'data', 'e2e-wall', 'scene.json');
  const onDisk = async () => JSON.parse(await readFile(scenePath(), 'utf8'));
  const saved = () => page.waitForSelector('.save-status.ok', { timeout: 10_000 });
  /** Wait until scene.json on disk passes `check`. */
  const onDiskWhen = async (check) => {
    for (let i = 0; i < 100; i++) {
      const scene = await onDisk().catch(() => null);
      if (scene && check(scene)) return scene;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('scene.json never reached the expected state');
  };

  it('creates a project and uploads videos', async () => {
    await page.goto(studio.url);
    await page.waitForSelector('.projects');
    await page.fill('input[aria-label="New project title"]', 'E2E wall');
    await page.click('button:has-text("New project")');
    await page.waitForURL(/#\/p\/e2e-wall\/library$/);
    await page.setInputFiles('[data-testid="upload-input"]', clips);
    await page.waitForFunction(() => document.querySelectorAll('.video-card').length === 3, null, { timeout: 30_000 });
    await saved();
    const scene = await onDisk();
    assert.deepEqual(scene.videos.map((v) => v.src).sort(), ['media/clip_0.mp4', 'media/clip_1.mp4', 'media/clip_2.mp4']);
    assert.ok(scene.videos.every((v) => v.id && v.title), 'ids and titles from the file names');
    // Thumbnails come from the server.
    await page.waitForFunction(() => Array.from(document.querySelectorAll('img.thumb')).filter((i) => /** @type {HTMLImageElement} */ (i).naturalWidth > 0).length === 3, null, { timeout: 15_000 });
  });

  it('edits details in the forms and sees them in the JSON', async () => {
    await page.click('.video-card:has-text("Clip 1")');
    await page.fill('.details input[aria-label="Title"]', 'Portrait clip');
    await page.fill('.details input[aria-label="Tags"]', 'place:Kyoto');
    await page.keyboard.press('Enter');
    await saved();
    let scene = await onDisk();
    const v = scene.videos.find((x) => x.src === 'media/clip_1.mp4');
    assert.equal(v.title, 'Portrait clip');
    assert.deepEqual(v.tags, ['place:Kyoto']);

    // Categories: create two, assign one to a selection of two videos.
    await page.click('button[aria-label="Close details"]');
    for (const name of ['Ocean', 'City']) {
      await page.fill('input[aria-label="New category"]', name);
      await page.click('.library-side form button[type="submit"]');
    }
    await page.click('.video-card >> nth=0');
    await page.click('.video-card >> nth=2', { modifiers: ['Shift'] });
    await page.click('.library-side .chip.toggle:has-text("Ocean")');
    await saved();
    scene = await onDisk();
    assert.deepEqual(scene.categories.map((c) => c.id), ['ocean', 'city']);
    assert.notEqual(scene.categories[0].color, scene.categories[1].color);
    assert.equal(scene.videos.filter((x) => x.categories?.includes('ocean')).length, 3);

    await page.click('a.tab:has-text("JSON")');
    await page.waitForSelector('.cm-editor');
    assert.match(await page.textContent('.cm-content'), /"title": "Portrait clip"/);
  });

  it('applies valid JSON edits and reports invalid ones', async () => {
    const scene = await onDisk();
    scene.title = 'Edited in JSON';
    await page.click('.cm-content');
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(JSON.stringify(scene, null, 2));
    await page.waitForFunction(() => document.querySelector('.crumb')?.textContent === 'Edited in JSON', null, { timeout: 10_000 });
    await saved();
    assert.equal((await onDisk()).title, 'Edited in JSON');

    // A schema problem: shown, marked in the editor, not saved.
    await page.click('.cm-content');
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(JSON.stringify({ ...scene, layout: { pack: 'spiral' } }, null, 2));
    await page.waitForSelector('.json-issues .issues li:has-text("layout.pack")', { timeout: 10_000 });
    await page.waitForSelector('.cm-lint-marker-error');
    assert.equal((await onDisk()).layout, undefined);
    await page.click('.json-issues .issues button');
    const selected = await page.evaluate(() => getSelection()?.toString());
    assert.equal(selected, '"spiral"', 'clicking a problem selects the value');
    await page.keyboard.insertText('"masonry"');
    await onDiskWhen((sc) => sc.layout?.pack === 'masonry');
  });

  it('undoes and redoes edits', async () => {
    await page.click('button[aria-label="Undo"]');
    await onDiskWhen((sc) => sc.layout === undefined);
    await page.click('button[aria-label="Redo"]');
    await onDiskWhen((sc) => sc.layout?.pack === 'masonry');
  });

  it('previews the layout, its pyramid and size live', async () => {
    await page.click('a.tab:has-text("Layout")');
    await page.waitForSelector('.wall-preview canvas');
    assert.match(await page.textContent('.stats'), /Masonry\s*\d+ columns of 384 px/);
    await page.click('button[role="radio"]:has-text("Grid: uniform cells")');
    await page.waitForFunction(() => /Grid\s*\d+ × \d+ cells of 384×216/.test(document.querySelector('.stats')?.textContent ?? ''));
    await page.fill('input[aria-label="Video size"]', '256x144');
    await page.waitForFunction(() => /cells of 256×144/.test(document.querySelector('.stats')?.textContent ?? ''));
    assert.match(await page.textContent('.stats'), /Estimate\s*[\d.]+ (KB|MB)/);
    await saved();
    const scene = await onDisk();
    assert.equal(scene.layout, undefined, 'grid is the default, so it is not written');
    assert.equal(scene.output.cell, '256x144');
  });

  it('builds, follows progress, previews and downloads the wall', async () => {
    await page.click('a.tab:has-text("Build")');
    await page.click('button.big:has-text("Build")');
    await page.waitForSelector('.job.running, .job.done', { timeout: 20_000 });
    await page.waitForSelector('.job.done', { timeout: 120_000 });
    assert.match(await page.textContent('.job'), /Tiles\s*\d+\/\d+/);
    const frame = page.frameLocator('iframe.preview-frame');
    await frame.locator('.vm-loading.vm-done').waitFor({ timeout: 20_000 });
    assert.equal(await frame.locator('.vm-label').count(), 1, 'one group: every video is in Ocean');

    const href = await page.getAttribute('a:has-text("Download zip")', 'href');
    const res = await fetch(new URL(href, studio.url));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');

    // The project list shows the build.
    await page.click('a.brand');
    await page.waitForSelector('.project-card:has-text("Built")');
  });

  it('keeps edits made elsewhere from being overwritten', async () => {
    await page.click('.project-card a');
    await page.waitForSelector('.library');
    const scene = await onDisk();
    await writeFile(scenePath(), JSON.stringify({ ...scene, description: 'Changed in an editor' }, null, 2));
    await page.click('.video-card >> nth=0');
    await page.fill('.details input[aria-label="Title"]', 'Mine');
    await page.waitForSelector('.banner.warn:has-text("changed somewhere else")', { timeout: 10_000 }).catch(async (err) => {
      await page.screenshot({ path: path.join(os.tmpdir(), 'vmap-studio-conflict.png') });
      throw err;
    });
    assert.equal((await onDisk()).description, 'Changed in an editor', 'nothing was overwritten');
    await page.click('button:has-text("Load the other version")');
    await saved();
    assert.equal(await page.inputValue('.details input[aria-label="Title"]'), scene.videos[0].title);
  });

  it('opens a broken scene.json for repair instead of overwriting it', async () => {
    const good = await onDisk();
    const broken = JSON.stringify(good, null, 2).replace('"title": "Edited in JSON",', '"title": "Fixed by hand",,');
    await writeFile(scenePath(), broken);
    await page.reload();
    await page.waitForSelector('.banner.error:has-text("valid JSON")');
    assert.equal(await page.locator('.video-card').count(), 0);
    assert.equal(await readFile(scenePath(), 'utf8'), broken, 'nothing saved over it');
    await page.click('a.tab:has-text("JSON")');
    await page.waitForSelector('.json-issues .bad-text:has-text("Not valid JSON")');
    assert.match(await page.textContent('.cm-content'), /"Fixed by hand",,/, 'the file as it is');
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(broken.replace(',,', ','));
    const fixed = await onDiskWhen((sc) => sc.title === 'Fixed by hand');
    assert.equal(fixed.videos.length, 3);
    await page.waitForSelector('.banner.error', { state: 'detached' });
  });

  it('logged no errors', () => {
    assert.deepEqual(errors, []);
  });
});
