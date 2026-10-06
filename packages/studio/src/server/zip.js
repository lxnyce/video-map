// Streaming ZIP writer for the "Download zip" export. Entries are stored, not
// compressed: tiles, stills, posters and media are already compressed, and the
// rest is a few small text files. Sizes come from stat, so the archive's
// length is known up front (Content-Length); CRCs are computed while
// streaming and written in data descriptors. ZIP64 records are added when a
// file, offset or the entry count passes the 32-bit limits, so full
// renditions over 4 GB export fine.

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

const LIMIT32 = 0xffffffff;
const LIMIT16 = 0xffff;
const FLAGS = 0x0008 | 0x0800; // sizes in a data descriptor; UTF-8 names

/**
 * @typedef {object} ZipEntry
 * @property {string} name   path inside the archive, with "/" separators
 * @property {string} file   file on disk
 * @property {number} size   bytes (from stat)
 * @property {Date} [mtime]
 */

/**
 * Lay out the archive: where each entry starts and how long the whole thing is.
 * @param {ZipEntry[]} entries
 * @param {{ zip64Threshold?: number }} [opts]  tests lower the threshold to exercise the ZIP64 records
 */
export function planZip(entries, { zip64Threshold = LIMIT32 } = {}) {
  let offset = 0;
  const items = entries.map((e) => {
    const name = Buffer.from(e.name, 'utf8');
    const zip64 = e.size >= zip64Threshold;
    // time, date and crc are filled in while streaming; centralExtra below.
    const item = { ...e, nameBytes: name, offset, zip64, descriptor: zip64 ? 24 : 16, centralExtra: Buffer.alloc(0), time: 0, date: 0, crc: 0 };
    offset += 30 + name.length + e.size + item.descriptor;
    return item;
  });
  const cdOffset = offset;
  let cdSize = 0;
  for (const it of items) {
    const extra = zip64Extra(it, zip64Threshold);
    it.centralExtra = extra;
    cdSize += 46 + it.nameBytes.length + extra.length;
  }
  const zip64End = items.length >= LIMIT16 || cdOffset >= zip64Threshold || cdSize >= zip64Threshold;
  const total = cdOffset + cdSize + (zip64End ? 56 + 20 : 0) + 22;
  return { items, cdOffset, cdSize, zip64End, total, zip64Threshold };
}

/**
 * The archive as a byte stream.
 * @param {ZipEntry[]} entries
 * @param {{ zip64Threshold?: number }} [opts]
 * @returns {{ stream: Readable, size: number }}
 */
export function zipStream(entries, opts) {
  const plan = planZip(entries, opts);
  return { stream: Readable.from(generate(plan), { objectMode: false }), size: plan.total };
}

/** @param {ReturnType<typeof planZip>} plan */
async function* generate(plan) {
  const threshold = plan.zip64Threshold;
  for (const it of plan.items) {
    const { time, date } = dosTime(it.mtime ?? new Date());
    it.time = time;
    it.date = date;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(it.zip64 ? 45 : 20, 4);
    head.writeUInt16LE(FLAGS, 6);
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    // CRC and sizes (14..25) stay zero: they follow in the data descriptor.
    head.writeUInt16LE(it.nameBytes.length, 26);
    head.writeUInt16LE(0, 28);
    yield head;
    yield it.nameBytes;

    let crc = 0;
    let read = 0;
    for await (const chunk of createReadStream(it.file)) {
      crc = crc32(chunk, crc);
      read += chunk.length;
      if (read > it.size) break;
      yield chunk;
    }
    if (read !== it.size) throw new Error(`${it.name} changed while it was being zipped`);
    it.crc = crc;

    const desc = Buffer.alloc(it.descriptor);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    if (it.zip64) {
      desc.writeBigUInt64LE(BigInt(it.size), 8);
      desc.writeBigUInt64LE(BigInt(it.size), 16);
    } else {
      desc.writeUInt32LE(it.size, 8);
      desc.writeUInt32LE(it.size, 12);
    }
    yield desc;
  }

  for (const it of plan.items) {
    const big = it.size >= threshold;
    const farOffset = it.offset >= threshold;
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(45, 4); // made by: 4.5, MS-DOS attributes
    head.writeUInt16LE(it.zip64 || farOffset ? 45 : 20, 6);
    head.writeUInt16LE(FLAGS, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(it.time, 12);
    head.writeUInt16LE(it.date, 14);
    head.writeUInt32LE(it.crc >>> 0, 16);
    head.writeUInt32LE(big ? LIMIT32 : it.size, 20);
    head.writeUInt32LE(big ? LIMIT32 : it.size, 24);
    head.writeUInt16LE(it.nameBytes.length, 28);
    head.writeUInt16LE(it.centralExtra.length, 30);
    // comment length, disk number, internal and external attributes stay zero
    head.writeUInt32LE(farOffset ? LIMIT32 : it.offset, 42);
    yield head;
    yield it.nameBytes;
    if (it.centralExtra.length) yield it.centralExtra;
  }

  const count = plan.items.length;
  const cdEnd = plan.cdOffset + plan.cdSize;
  if (plan.zip64End) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4); // size of the rest of the record
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(plan.cdSize), 40);
    rec.writeBigUInt64LE(BigInt(plan.cdOffset), 48);
    yield rec;
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdEnd), 8);
    loc.writeUInt32LE(1, 16);
    yield loc;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(plan.zip64End ? LIMIT16 : count, 8);
  end.writeUInt16LE(plan.zip64End ? LIMIT16 : count, 10);
  end.writeUInt32LE(plan.zip64End ? LIMIT32 : plan.cdSize, 12);
  end.writeUInt32LE(plan.zip64End ? LIMIT32 : plan.cdOffset, 16);
  yield end;
}

/** The central directory's ZIP64 extra field: only the values that overflow, in this order. */
function zip64Extra(it, threshold) {
  const values = [];
  if (it.size >= threshold) values.push(it.size, it.size); // uncompressed, compressed
  if (it.offset >= threshold) values.push(it.offset);
  if (!values.length) return Buffer.alloc(0);
  const buf = Buffer.alloc(4 + values.length * 8);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return buf;
}

/** @param {Date} d */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
