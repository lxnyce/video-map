// Test helper: a minimal reader for the Studio's stored-only zips.

import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

/**
 * Read a stored-only zip through its central directory, ZIP64 included, and
 * check each entry against its local header and CRC.
 * @param {Buffer} buf
 */
export function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'end of central directory record');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    assert.equal(buf.readUInt32LE(loc), 0x07064b50, 'ZIP64 locator');
    const rec = Number(buf.readBigUInt64LE(loc + 8));
    assert.equal(buf.readUInt32LE(rec), 0x06064b50, 'ZIP64 end record');
    count = Number(buf.readBigUInt64LE(rec + 32));
    cdSize = Number(buf.readBigUInt64LE(rec + 40));
    cdOffset = Number(buf.readBigUInt64LE(rec + 48));
    assert.equal(rec, cdOffset + cdSize);
    zip64 = true;
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header');
    const crc = buf.readUInt32LE(p + 16);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (extra.length) {
      assert.equal(extra.readUInt16LE(0), 1, 'ZIP64 extra field');
      let q = 4;
      if (size === 0xffffffff) {
        size = Number(extra.readBigUInt64LE(q));
        q += 16;
      }
      if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(q));
    }
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `local header of ${name}`);
    const localName = buf.readUInt16LE(offset + 26);
    const start = offset + 30 + localName + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(crc32(data) >>> 0, crc, `CRC of ${name}`);
    assert.equal(buf.readUInt32LE(start + size), 0x08074b50, `data descriptor of ${name}`);
    entries.push({ name, data });
    p += 46 + nameLen + extraLen;
  }
  assert.equal(p, cdOffset + cdSize);
  return { entries, zip64 };
}
