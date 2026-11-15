/**
 * POSIX cksum, in JS (ACH-51): the CRC-32 with polynomial 0x04C11DB7 (most significant bit first,
 * no reflection, starting at 0), then the input's length fed in a byte at a time (low byte first,
 * only as many bytes as it needs), then complemented. Returns what `cksum < file` prints, "<crc>
 * <length>", byte for byte, so the push guard's shell shim can compare its own cksum against it.
 * It replaces a spawnSync('cksum') that sometimes never got its end of input and hung the caller.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const step = (crc: number, byte: number) => ((crc << 8) ^ TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;

/** cksum's output for some bytes (a string is taken as its UTF-8 bytes): "<crc> <length>". */
export function cksum(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let crc = 0;
  for (const byte of bytes) crc = step(crc, byte);
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) crc = step(crc, n % 256);
  return `${(~crc) >>> 0} ${bytes.length}`;
}
