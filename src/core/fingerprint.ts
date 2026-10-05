// 来源指纹与许可义务推导。
// 指纹只依赖来源身份字段（上游、名称、版本），与“出现在哪个发布物”无关，
// 因此同一依赖 / 同一片段的多份副本天然归并。

import type { ObligationType } from './types.js';

const FINGERPRINT_PREFIX = 'fp';

/** cyrb53：稳定的非加密哈希，输出可排序、可比较的十六进制指纹 */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return h.toString(16).padStart(13, '0');
}

export function computeFingerprint(p: {
  upstream?: string;
  name: string;
  version?: string;
}): string {
  const canon = [p.upstream?.trim() || '-', p.name.trim().toLowerCase(), p.version?.trim() || '-'].join('§');
  return `${FINGERPRINT_PREFIX}${cyrb53(canon)}`;
}

const FAMILY = {
  mit: ['MIT'],
  bsd: ['BSD-2-Clause', 'BSD-3-Clause'],
  apache: ['Apache-2.0'],
  copyleft: ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0'],
} as const;

export function familyOf(license: string): 'mit' | 'bsd' | 'apache' | 'copyleft' | 'unknown' {
  const l = license.trim();
  if ((FAMILY.mit as readonly string[]).includes(l)) return 'mit';
  if ((FAMILY.bsd as readonly string[]).includes(l)) return 'bsd';
  if ((FAMILY.apache as readonly string[]).includes(l)) return 'apache';
  if ((FAMILY.copyleft as readonly string[]).includes(l)) return 'copyleft';
  return 'unknown';
}

export const OBLIGATION_LABEL: Record<ObligationType, string> = {
  attribution: '署名与版权声明',
  sourceOffer: '源码获取方式交付',
  modificationDisclosure: '修改披露',
};

/**
 * 由许可证 + 是否修改推导义务类型集合。
 * - MIT / BSD：署名；
 * - Apache-2.0：署名，且我方修改过副本时须披露修改；
 * - Copyleft（GPL/AGPL/LGPL）：署名 + 源码获取方式 + 修改披露（修改时）；
 * - 未知：不作为合规义务产出，由“许可证补全”闸门处理（未补全不进可发布报告）。
 */
export function requiredObligations(license: string, modified: boolean): ObligationType[] {
  switch (familyOf(license)) {
    case 'mit':
      return ['attribution'];
    case 'bsd':
      return ['attribution'];
    case 'apache':
      return modified ? ['attribution', 'modificationDisclosure'] : ['attribution'];
    case 'copyleft':
      return modified
        ? ['attribution', 'sourceOffer', 'modificationDisclosure']
        : ['attribution', 'sourceOffer'];
    default:
      return [];
  }
}

export function obligationMaterial(type: ObligationType, name: string, version?: string): string {
  const what = version ? `${name} ${version}` : name;
  switch (type) {
    case 'attribution':
      return `在 NOTICE / 随附声明中保留 ${what} 的版权声明与许可证全文`;
    case 'sourceOffer':
      return `随发布物提供 ${what} 对应完整源码（含我方构建脚本）或书面获取要约`;
    case 'modificationDisclosure':
      return `在修改说明中列出对 ${what} 的修改日期、文件与内容摘要`;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export function obligationBasis(type: ObligationType, license: string): string {
  switch (type) {
    case 'attribution':
      return `${license}：再发布须保留版权声明与许可声明`;
    case 'sourceOffer':
      return `${license}：分发二进制时须提供对应源码`;
    case 'modificationDisclosure':
      return `${license}：修改后的衍生版本须显著标注修改内容`;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
