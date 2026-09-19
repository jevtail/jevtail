// Template mining: collapse log lines that differ only in variables into one
// key, so Jev judges one sample per template instead of every line.
// ponytail: regex masking. Move to Drain (prefix-tree) if masking under-merges
// on real traffic.
const MASKS: [RegExp, string][] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>"],
  [/\b[0-9a-f]{16,}\b/gi, "<HEX>"],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TS>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<IP>"],
  [/https?:\/\/[^\s"']+/g, "<URL>"],
  [/\/[\w.-]+(?:\/[\w.-]+)+/g, "<PATH>"],
  [/"[^"\n]{0,80}"/g, "<STR>"],
  [/(?<![A-Za-z])\d+(?:\.\d+)?(?:ms|s|kb|mb|gb|%)?(?![A-Za-z0-9])/gi, "<N>"],
];

export function mask(message: string): string {
  let m = message.trim().slice(0, 500);
  for (const [re, tok] of MASKS) m = m.replace(re, tok);
  return m.replace(/\s+/g, " ");
}

export async function templateKey(source: string, level: string, message: string): Promise<{ key: string; masked: string }> {
  const masked = mask(message);
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${source}\0${level}\0${masked}`));
  const key = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
  return { key, masked };
}
