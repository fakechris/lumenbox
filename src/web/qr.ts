/**
 * A QR code for a short text, as an SVG (ISO/IEC 18004): what the page shows a phone to pair it
 * (INV-2214). Byte mode, error correction level M, versions 1 to 10 — up to 213 bytes, far more than a
 * pairing link needs — and the mask the standard's penalty rule scores lowest. No dependency: the
 * repository takes none for this, and the algorithm is small and fixed.
 *
 * The structure follows the standard's own order: data bits, Reed–Solomon error correction per block,
 * interleaving, the function patterns (finders, timing, alignment, format and version information),
 * the codewords in their zigzag, then the mask.
 */

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** The longest text, in UTF-8 bytes, a QR code here holds (version 10, level M, byte mode). */
export const QR_MAX_BYTES = 213;

const dataCodewords = (version: number) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(x: number, y: number): number {
  let z = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> bit) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data: readonly number[], by: readonly number[]): number[] {
  const result = by.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    by.forEach((coefficient, at) => { result[at]! ^= multiply(coefficient, factor); });
  }
  return result;
}

/** The data codewords split into blocks, each with its error correction, interleaved as the symbol holds them. */
function withErrorCorrection(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS[version]!, eccLength = ECC_PER_BLOCK[version]!, raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks), shortLength = Math.floor(raw / blocks), by = divisor(eccLength);
  const all: number[][] = [];
  for (let block = 0, at = 0; block < blocks; block += 1) {
    const part = data.slice(at, at + shortLength - eccLength + (block < shortBlocks ? 0 : 1));
    at += part.length;
    const ecc = remainder(part, by);
    if (block < shortBlocks) part.push(0);
    all.push([...part, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < all[0]!.length; i += 1) all.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]!); });
  return result;
}

/** The modules of a QR code for `text`: `true` is dark. Throws when the text is longer than version 10 holds. */
export function qrModules(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, "utf8")];
  let version = 1;
  while (version <= MAX_VERSION && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version += 1;
  if (version > MAX_VERSION) throw new Error(`a QR code here holds at most ${dataCodewords(MAX_VERSION) - 3} bytes`);
  const bits: number[] = [];
  const put = (value: number, length: number) => { for (let bit = length - 1; bit >= 0; bit -= 1) bits.push((value >>> bit) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let at = 0; at < bits.length; at += 8) data.push(bits.slice(at, at + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; fixed[y]![x] = true; };

  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx, y = cy + dy, distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
    }
  }
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2, step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const positions = [6];
    for (let at = size - 7; positions.length < count; at -= step) positions.splice(1, 0, at);
    for (const [i, x] of positions.entries()) for (const [j, y] of positions.entries()) {
      if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const format = (mask: number) => {
    const value = (0 << 3) | mask; // level M is 00
    let rem = value;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const word = ((value << 10) | rem) ^ 0x5412, bit = (i: number) => ((word >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const word = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((word >>> i) & 1) !== 0, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  const codewords = withErrorCorrection(data, version);
  let at = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vertical : vertical;
        if (fixed[y]![x] || at >= codewords.length * 8) continue;
        modules[y]![x] = ((codewords[at >>> 3]! >>> (7 - (at & 7))) & 1) !== 0;
        at += 1;
      }
    }
  }

  const masks: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const apply = (mask: number) => { for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fixed[y]![x] && masks[mask]!(x, y)) modules[y]![x] = !modules[y]![x]; };
  let best = 0, lowest = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    apply(mask); format(mask);
    const score = penalty(modules);
    if (score < lowest) { lowest = score; best = mask; }
    apply(mask);
  }
  apply(best); format(best);
  return modules;
}

/** The standard's penalty for a masked symbol: runs, 2×2 blocks, finder-like patterns, and the balance of dark and light. */
function penalty(modules: readonly boolean[][]): number {
  const size = modules.length;
  let result = 0;
  const line = (get: (i: number) => boolean) => {
    let color = false, run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    const add = (length: number) => { if (history[0] === 0) length += size; history.pop(); history.unshift(length); };
    const patterns = () => {
      const n = history[1]!, core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) + (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0);
    };
    for (let i = 0; i < size; i += 1) {
      if (get(i) === color) { run += 1; if (run === 5) result += 3; else if (run > 5) result += 1; continue; }
      add(run);
      if (!color) result += patterns() * 40;
      color = get(i); run = 1;
    }
    if (color) { add(run); run = 0; }
    add(run + size);
    result += patterns() * 40;
  };
  for (let y = 0; y < size; y += 1) line(x => modules[y]![x]!);
  for (let x = 0; x < size; x += 1) line(y => modules[y]![x]!);
  for (let y = 0; y < size - 1; y += 1) for (let x = 0; x < size - 1; x += 1) {
    const color = modules[y]![x];
    if (color === modules[y]![x + 1] && color === modules[y + 1]![x] && color === modules[y + 1]![x + 1]) result += 3;
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0), total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

/** The QR code as an SVG document: a quiet zone of four modules, one path of dark squares. */
export function qrSvg(text: string): string {
  const modules = qrModules(text), size = modules.length + 8;
  const path = modules.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + 4} ${y + 4}h1v1h-1z`] : []))).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
