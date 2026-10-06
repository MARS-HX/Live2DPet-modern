/**
 * Minimal ZIP extractor.
 *
 * Why not a dependency: the app ships without a bundler and keeps its runtime
 * dependencies small; the only thing we need is to unpack the Vosk model
 * archive, which is a plain deflate zip. Node's zlib does the compression part
 * — this file supplies the container parsing.
 *
 * Supports the two methods that actually appear in the wild for such archives:
 *   0 = stored, 8 = deflate.  Anything else is reported, not guessed at.
 *
 * Security: entry names are never written as-is. Anything that would escape the
 * destination (absolute paths, `..`, drive letters, symlinks) is rejected,
 * because a downloaded archive must not be able to write outside its folder.
 */
'use strict';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Find the End Of Central Directory record, scanning back over the comment. */
function findEocd(buf) {
    const min = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    return -1;
}

/** Reject anything that could escape `destDir` once joined. */
function isUnsafeName(name) {
    if (!name) return true;
    const n = name.replace(/\\/g, '/');
    if (n.startsWith('/')) return true;                 // absolute
    if (/^[a-zA-Z]:/.test(n)) return true;              // drive letter
    if (n.split('/').some((part) => part === '..')) return true;
    return false;
}

/** Parse the central directory into a list of entries. */
function listEntries(buf) {
    const eocd = findEocd(buf);
    if (eocd === -1) throw new Error('not_a_zip: no end-of-central-directory record');
    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);

    const entries = [];
    for (let i = 0; i < count; i++) {
        if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) {
            throw new Error('not_a_zip: bad central directory entry');
        }
        const method = buf.readUInt16LE(offset + 10);
        const compSize = buf.readUInt32LE(offset + 20);
        const rawSize = buf.readUInt32LE(offset + 24);
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const externalAttr = buf.readUInt32LE(offset + 38);
        const localOffset = buf.readUInt32LE(offset + 42);
        const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');

        entries.push({
            name,
            method,
            compSize,
            rawSize,
            localOffset,
            isDirectory: name.endsWith('/') || (externalAttr & 0x10) !== 0,
        });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** Read and decompress one entry's bytes. */
function readEntry(buf, entry, zlib) {
    const lo = entry.localOffset;
    if (buf.readUInt32LE(lo) !== LOC_SIG) throw new Error(`bad_local_header: ${entry.name}`);
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const raw = buf.slice(start, start + entry.compSize);

    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`unsupported_compression_method:${entry.method} (${entry.name})`);
}

/**
 * Extract an archive into `destDir`.
 * @returns {{files:number, dirs:number, skipped:string[]}}
 */
function extractZip(buf, destDir, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const zlib = deps.zlib || require('zlib');

    const entries = listEntries(buf);
    const skipped = [];
    let files = 0, dirs = 0;

    const root = path.resolve(destDir);
    for (const entry of entries) {
        if (isUnsafeName(entry.name)) { skipped.push(entry.name); continue; }
        const target = path.resolve(root, entry.name);
        if (target !== root && !target.startsWith(root + path.sep)) { skipped.push(entry.name); continue; }

        if (entry.isDirectory) {
            fs.mkdirSync(target, { recursive: true });
            dirs++;
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readEntry(buf, entry, zlib));
        files++;
    }
    return { files, dirs, skipped };
}

module.exports = { extractZip, listEntries, isUnsafeName, findEocd, readEntry };
