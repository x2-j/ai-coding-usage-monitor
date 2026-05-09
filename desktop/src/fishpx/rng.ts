export function hashSeed(seed: string | number): number {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0;
  }

  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class Random {
  private state: number;

  constructor(seed: string | number) {
    this.state = hashSeed(seed) || 1;
  }

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) {
      throw new Error("Cannot pick from an empty list.");
    }
    return item;
  }

  id(prefix: string): string {
    return `${prefix}-${Math.floor(this.next() * 0xffffffff)
      .toString(36)
      .padStart(6, "0")}`;
  }
}

export function seedStream(seed: string | number, stream: string): string {
  return `${String(seed)}:${stream}`;
}
