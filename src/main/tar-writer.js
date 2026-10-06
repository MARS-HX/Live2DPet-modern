/**
 * Minimal USTAR tar writer.
 *
 * Why this exists: the WASM speech engine (vosk-browser) loads its model from a
 * single **uncompressed** tar archive — it contains a tar parser but no gzip
 * support. The model ships as a zip, so the archive has to be built locally
 * from the files already on disk. That is a matter of writing a few 512-byte
 * headers, which is cheaper than adding a dependency.
 *
 * Only what the engine needs is implemented: regular files, directories, and
 * long names via the USTAR `prefix` field. No symlinks, no PAX extensions.
 */
'use strict';

const BLOCK = 512;

/** Octal, zero-padded, NUL-terminated — the USTAR numeric field format. */
function octalField(value, length) {
    const s = Math.max(0, Math.floor(value)).toString(8);
    return s.padStart(length - 1, '0').slice(-(length - 1)) + '\0';
}

/**
 * Split a path into the USTAR name (<=100) and prefix (<=155) fields.
 * Anything that cannot be represented is rejected rather than silently
 * truncated into a corrupt entry.
 */
function splitName(name) {
    const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (Buffer.byteLength(clean) <= 100) return { name: clean, prefix: '' };
    for (let i = clean.lastIndexOf('/'); i > 0; i = clean.lastIndexOf('/', i - 1)) {
        const prefix = clean.slice(0, i);
        const rest = clean.slice(i + 1);
        if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) {
            return { name: rest, prefix };
        }
    }
    throw new Error(`tar_name_too_long:${clean}`);
}

function buildHeader(entry) {
    const header = Buffer.alloc(BLOCK);
    const { name, prefix } = splitName(entry.name);

    header.write(name, 0, 100, 'utf8');
    header.write(octalField(entry.mode === undefined ? 0o644 : entry.mode, 8), 100, 8, 'ascii');
    header.write(octalField(0, 8), 108, 8, 'ascii');            // uid
    header.write(octalField(0, 8), 116, 8, 'ascii');            // gid
    header.write(octalField(entry.isDirectory ? 0 : entry.size, 12), 124, 12, 'ascii');
    header.write(octalField(entry.mtime || 0, 12), 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');                   // checksum placeholder
    header.write(entry.isDirectory ? '5' : '0', 156, 1, 'ascii'); // typeflag
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (prefix) header.write(prefix, 345, 155, 'utf8');

    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return header;
}

/**
 * Build a tar archive from a list of entries.
 * @param {Array<{name:string, data?:Buffer, size?:number, isDirectory?:boolean, mtime?:number}>} entries
 * @returns {Buffer}
 */
function buildTar(entries) {
    const parts = [];
    for (const e of entries) {
        const isDir = !!e.isDirectory;
        const data = isDir ? null : (e.data || Buffer.alloc(0));
        parts.push(buildHeader({
            name: e.name,
            size: isDir ? 0 : data.length,
            isDirectory: isDir,
            mtime: e.mtime,
            mode: e.mode,
        }));
        if (!isDir) {
            parts.push(data);
            const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
            if (pad) parts.push(Buffer.alloc(pad));
        }
    }
    parts.push(Buffer.alloc(BLOCK * 2));   // end-of-archive marker
    return Buffer.concat(parts);
}

/**
 * Walk a directory and return tar entries for it (files + directories).
 * `prefix` is prepended, so the archive can reproduce the archive layout the
 * engine is tested against (a single top-level folder).
 */
function entriesFromDirectory(dir, prefix = '', deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const out = [];
    const walk = (current, rel) => {
        const items = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const item of items) {
            const abs = path.join(current, item.name);
            const relPath = rel ? `${rel}/${item.name}` : item.name;
            if (item.isDirectory()) {
                out.push({ name: `${prefix}${relPath}/`, isDirectory: true });
                walk(abs, relPath);
            } else if (item.isFile()) {
                out.push({ name: `${prefix}${relPath}`, data: fs.readFileSync(abs) });
            }
        }
    };
    walk(dir, '');
    return out;
}

module.exports = { buildTar, entriesFromDirectory, splitName, octalField, BLOCK };
