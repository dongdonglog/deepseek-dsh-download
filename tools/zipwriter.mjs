/**
 * Minimal pure-Node ZIP writer (deflate, UTF-8 names, unix modes).
 * No third-party dependencies — works on macOS / Linux / Windows alike.
 * Used by tools/build-offline.mjs to produce the offline bundle zip.
 */

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

export function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
	const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
	const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
	return { time, day };
}

/**
 * Build a zip Buffer from entries.
 * @param {Array<{name: string, data: Buffer, mode?: number}>} entries
 *   name: path inside the zip using "/" separators (may be a dir ending with "/").
 *   mode: unix permission bits (e.g. 0o755) — stored in external attrs so
 *         extractors that honor them can restore the executable bit.
 * @returns {Buffer}
 */
export function zipEntries(entries, { level = 6 } = {}) {
	const now = dosDateTime();
	const chunks = [];
	const central = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const isDir = entry.name.endsWith("/");
		const data = isDir ? Buffer.alloc(0) : entry.data;
		const compressed = isDir ? Buffer.alloc(0) : deflateRawSync(data, { level });
		const crc = isDir ? 0 : crc32(data);
		const mode = entry.mode ?? (isDir ? 0o755 : 0o644);

		// ---- local file header ----
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); // signature
		local.writeUInt16LE(20, 4); // version needed (2.0 = deflate)
		local.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 names
		local.writeUInt16LE(8, 8); // method: deflate
		local.writeUInt16LE(now.time, 10);
		local.writeUInt16LE(now.day, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28); // extra length

		chunks.push(local, nameBuf, compressed);
		const localOffset = offset;
		offset += 30 + nameBuf.length + compressed.length;

		// ---- central directory record ----
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0); // signature
		cen.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix | 2.0
		cen.writeUInt16LE(20, 6); // version needed
		cen.writeUInt16LE(0x0800, 8); // UTF-8
		cen.writeUInt16LE(8, 10); // deflate
		cen.writeUInt16LE(now.time, 12);
		cen.writeUInt16LE(now.day, 14);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(compressed.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt16LE(0, 30); // extra
		cen.writeUInt16LE(0, 32); // comment
		cen.writeUInt16LE(0, 34); // disk number start
		cen.writeUInt16LE(0, 36); // internal attrs
		cen.writeUInt32LE((mode & 0xffff) << 16, 38); // external attrs (unix mode)
		cen.writeUInt32LE(localOffset, 42);

		central.push({ buf: cen, nameBuf });
	}

	// ---- central directory ----
	let centralSize = 0;
	for (const { buf, nameBuf } of central) {
		chunks.push(buf, nameBuf);
		centralSize += buf.length + nameBuf.length;
	}
	const centralOffset = offset;

	// ---- end of central directory ----
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); // signature
	eocd.writeUInt16LE(0, 4); // disk number
	eocd.writeUInt16LE(0, 6); // disk with central dir
	eocd.writeUInt16LE(central.length, 8); // entries this disk
	eocd.writeUInt16LE(central.length, 10); // entries total
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(centralOffset, 16);
	eocd.writeUInt16LE(0, 20); // comment length
	chunks.push(eocd);

	return Buffer.concat(chunks);
}
