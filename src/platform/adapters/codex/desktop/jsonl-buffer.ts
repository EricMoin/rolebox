export class JsonLineLimitError extends Error {
  constructor() { super("JSON line exceeds the configured byte limit"); }
}

/** Keeps partial UTF-8 bytes intact and copies each completed line at most once. */
export class JsonLineBuffer {
  private parts: Buffer[] = [];
  private size = 0;
  private readonly limit: number;

  constructor(limit: number) { this.limit = limit; }

  write(chunk: Buffer, line: (value: Buffer) => boolean | void): void {
    let start = 0;
    let end: number;
    while ((end = chunk.indexOf(10, start)) >= 0) {
      this.append(chunk.subarray(start, end));
      const value = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.size);
      this.clear();
      if (line(value) === false) return;
      start = end + 1;
    }
    this.append(chunk.subarray(start));
  }

  clear(): void { this.parts = []; this.size = 0; }

  private append(part: Buffer): void {
    if (this.size + part.length > this.limit) throw new JsonLineLimitError();
    if (part.length) { this.parts.push(part); this.size += part.length; }
  }
}
