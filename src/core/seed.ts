import { AppState } from './types.js';
import { computeFingerprint } from './fingerprint.js';

// 首次进入的演示数据：含 3 条无指纹旧数据（两条是同一上游的重复记录），
// 一条 UNKNOWN 许可证来源，以及一个尚未冻结的发布批次。
export function buildSeed(): AppState {
  const s: AppState = { sources: [], artifacts: {}, batches: [], audit: [], idemSeen: [], alias: {}, seq: 0 };
  const nid = (p: string) => `${p}${++s.seq}`;

  const legacy1 = {
    id: nid('s'), fingerprint: '', name: 'highlight.js', version: '11.9.0',
    upstream: 'https://github.com/highlightjs/highlight.js', license: 'BSD-3-Clause',
    refs: [{ id: nid('ref'), kind: 'snippet' as const, location: 'vendor/hljs-core.js:1-820', legacy: true }],
  };
  const legacy2 = {
    id: nid('s'), fingerprint: '', name: 'Highlight.js', version: '11.9.0',
    upstream: 'https://github.com/highlightjs/highlight.js', license: 'BSD-3-Clause',
    refs: [{ id: nid('ref'), kind: 'snippet' as const, location: 'docs/demo/hljs-lang.js', legacy: true }],
  };
  const legacy3 = {
    id: nid('s'), fingerprint: '', name: 'date-fmt-shim', version: '0.3',
    upstream: 'https://internal.example.com/date-fmt', license: 'MIT',
    refs: [{ id: nid('ref'), kind: 'dependency' as const, location: 'package.json (内部镜像)', legacy: true }],
  };
  s.sources.push(legacy1, legacy2, legacy3);

  const fp = (name: string, version: string, upstream: string) => computeFingerprint({ name, version, upstream });
  const react = {
    id: nid('s'), fingerprint: fp('react', '18.3.1', 'https://registry.npmjs.org/react'),
    name: 'react', version: '18.3.1', upstream: 'https://registry.npmjs.org/react', license: 'MIT',
    refs: [{ id: nid('ref'), kind: 'dependency' as const, location: 'package.json' }],
  };
  const mystery = {
    id: nid('s'), fingerprint: fp('mystery-reader', '0.4.2', 'https://example.com/mystery-reader'),
    name: 'mystery-reader', version: '0.4.2', upstream: 'https://example.com/mystery-reader', license: 'UNKNOWN',
    refs: [{ id: nid('ref'), kind: 'snippet' as const, location: 'src/reader/parse.ts:55-140' }],
  };
  const gpl = {
    id: nid('s'), fingerprint: fp('pdf-embed-gpl', '2.1.0', 'https://example.com/pdf-embed'),
    name: 'pdf-embed-gpl', version: '2.1.0', upstream: 'https://example.com/pdf-embed', license: 'GPL-3.0',
    refs: [{ id: nid('ref'), kind: 'dependency' as const, location: 'package.json', modified: true }],
  };
  s.sources.push(react, mystery, gpl);

  s.artifacts = {
    a1: { id: 'a1', name: 'aurora-web.tar.gz', sourceIds: [legacy1.id, legacy2.id, legacy3.id, react.id, mystery.id, gpl.id] },
    a2: { id: 'a2', name: 'docs-site.zip', sourceIds: [legacy1.id, react.id] },
  };
  s.seq = 12;
  s.batches = [{
    id: nid('b'), name: 'Aurora 2026.10', version: 1, status: 'open',
    artifactIds: ['a1', 'a2'], processedArtifacts: [], scopeSig: {}, obligations: [],
    confirmations: [], reportKeys: [], createdAt: Date.now(),
  }];
  return s;
}
