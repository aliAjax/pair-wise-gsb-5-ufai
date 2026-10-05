// 来源指纹：同一依赖的不同记录（多处登记）或同一代码片段的重复粘贴，
// 只要归一键相同，就归入同一指纹，义务只生成一份。

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintSource(input: {
  kind: 'dependency' | 'snippet';
  name: string;
  version?: string;
  code?: string;
}): Promise<string> {
  // 依赖按 name@version 归并；片段按归一化代码归并（去除空白差异）
  if (input.kind === 'dependency') {
    const key = `dep:${input.name.trim().toLowerCase()}@${(input.version || '').trim()}`;
    return sha256Hex(key);
  }
  const normalized = (input.code || '').replace(/\s+/g, ' ').trim();
  return sha256Hex(`snippet:${normalized}`);
}

export function short(fp: string | null | undefined, n = 10): string {
  return fp ? fp.slice(0, n) : '—';
}
