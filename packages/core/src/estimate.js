// Output size estimates: printed by `vmap build --dry-run` before encoding, and
// redrawn live by the Studio as settings change. Pure, so both can use it.

/**
 * The probe facts the estimate reads (the builder's ProbeInfo has more).
 * @typedef {{ width: number, height: number, fps: number, duration: number, videoCodec: string, pixFmt: string,
 *   audioCodec: string|null, container: string, rotation: number, sar: number, hdr: boolean }} SourceInfo
 */

/**
 * Can the source be served as-is (remuxed) as the full rendition?
 * @param {SourceInfo} p
 * @param {number} maxHeight
 */
export function isWebCompatible(p, maxHeight) {
  return p.videoCodec === 'h264'
    && (p.pixFmt === 'yuv420p' || p.pixFmt === 'yuvj420p')
    && p.height <= maxHeight
    && (p.audioCodec === null || p.audioCodec === 'aac')
    && /mp4|mov/.test(p.container)
    && p.rotation === 0
    && Math.abs(p.sar - 1) <= 0.01
    && !p.hdr;
}

/**
 * Rough output size, printed before encoding. Tiles typically land at ~70% of
 * their bitrate cap; full renditions are copied when already web-friendly.
 * `withMedia` and `withoutMedia` are the totals with and without full
 * renditions, whichever this build makes (plan §5.3). Every arrangement
 * (`walls`) has its own tiles and stills.
 * @param {{ config: import('./config.js').ResolvedConfig, walls: Array<{ pyramid: { tile: { w: number, h: number } }, tiles: any[][] }>, sources: Array<{ probe: SourceInfo }> }} o
 */
export function estimateSizes({ config, walls, sources }) {
  const { fps, duration } = config.preview;
  let tileCount = 0;
  let tileBytes = 0;
  let stillBytes = 0;
  for (const { pyramid, tiles } of walls) {
    const count = tiles.reduce((n, level) => n + level.length, 0);
    const { w, h } = pyramid.tile;
    tileCount += count;
    tileBytes += count * ((w * h * fps * 0.12) / 8) * duration * 0.7;
    stillBytes += config.output.stills ? count * w * h * 0.09 : 0;
  }
  let mediaBytes = 0;
  for (const s of sources) {
    const p = s.probe;
    const scale = Math.min(1, config.output.full.maxHeight / p.height);
    const bps = isWebCompatible(p, config.output.full.maxHeight)
      ? p.width * p.height * Math.min(p.fps, 60) * 0.1
      : p.width * scale * p.height * scale * Math.min(p.fps, 30) * 0.065;
    mediaBytes += (bps / 8) * p.duration + (p.audioCodec ? 16000 * p.duration : 0);
  }
  const posterBytes = sources.length * 40_000;
  const withoutMedia = Math.round(tileBytes + stillBytes + posterBytes);
  const withMedia = withoutMedia + Math.round(mediaBytes);
  const full = config.output.full.enabled;
  return {
    tileCount,
    tiles: Math.round(tileBytes),
    stills: Math.round(stillBytes),
    media: full ? Math.round(mediaBytes) : 0,
    posters: posterBytes,
    total: full ? withMedia : withoutMedia,
    withMedia,
    withoutMedia,
  };
}
