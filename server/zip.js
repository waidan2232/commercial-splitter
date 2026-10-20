'use strict';
// Streams files into a .zip (stored, no compression: video doesn't compress), with ZIP64 for big archives.

const fs = require('fs');
const zlib = require('zlib');

const MAX32 = 0xffffffff;

function crcOfFile(file) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    fs.createReadStream(file)
      .on('data', (d) => { crc = zlib.crc32(d, crc); })
      .on('error', reject)
      .on('end', () => resolve(crc >>> 0));
  });
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function write(out, buf) {
  return new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('closed'));
    if (out.write(buf)) return resolve();
    const done = (err) => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      if (err) reject(err); else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('closed'));
    out.on('drain', onDrain);
    out.on('close', onClose);
  });
}

function pipeFile(file, out) {
  return new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    const onClose = () => { s.destroy(); reject(new Error('closed')); };
    out.once('close', onClose);
    s.on('error', (e) => { out.off('close', onClose); reject(e); });
    s.on('end', () => { out.off('close', onClose); resolve(); });
    s.pipe(out, { end: false });
  });
}

/** Writes entries [{ path, name }] as a zip to the writable stream `out` (an HTTP response). */
async function streamZip(entries, out) {
  let offset = 0;
  const central = [];
  for (const e of entries) {
    const stat = fs.statSync(e.path);
    const size = stat.size;
    const crc = await crcOfFile(e.path);
    const name = Buffer.from(e.name, 'utf8');
    const { time, day } = dosTime(stat.mtime);
    const big = size >= MAX32 || offset >= MAX32;

    const zip64Local = Buffer.alloc(big ? 20 : 0);
    if (big) {
      zip64Local.writeUInt16LE(0x0001, 0);
      zip64Local.writeUInt16LE(16, 2);
      zip64Local.writeBigUInt64LE(BigInt(size), 4);
      zip64Local.writeBigUInt64LE(BigInt(size), 12);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(big ? MAX32 : size, 18);
    local.writeUInt32LE(big ? MAX32 : size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(zip64Local.length, 28);
    await write(out, Buffer.concat([local, name, zip64Local]));
    await pipeFile(e.path, out);
    central.push({ name, crc, size, offset, time, day, big });
    offset += local.length + name.length + zip64Local.length + size;
  }

  const cdStart = offset;
  for (const c of central) {
    const extra = Buffer.alloc(c.big ? 28 : 0);
    if (c.big) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(c.size), 4);
      extra.writeBigUInt64LE(BigInt(c.size), 12);
      extra.writeBigUInt64LE(BigInt(c.offset), 20);
    }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(0x031e, 4); // made by: Unix, spec 3.0
    h.writeUInt16LE(c.big ? 45 : 20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.day, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.big ? MAX32 : c.size, 20);
    h.writeUInt32LE(c.big ? MAX32 : c.size, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    h.writeUInt32LE(c.big ? MAX32 : c.offset, 42);
    await write(out, Buffer.concat([h, c.name, extra]));
    offset += h.length + c.name.length + extra.length;
  }
  const cdSize = offset - cdStart;
  const needs64 = cdStart >= MAX32 || central.length >= 0xffff || central.some((c) => c.big);
  if (needs64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(central.length), 24);
    rec.writeBigUInt64LE(BigInt(central.length), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(offset), 8);
    loc.writeUInt32LE(1, 16);
    await write(out, Buffer.concat([rec, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(central.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(central.length, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(needs64 ? MAX32 : cdStart, 16);
  await write(out, end);
}

module.exports = { streamZip };
