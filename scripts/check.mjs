/**
 * 项目自检 · node scripts/check.mjs
 * ─────────────────────────────────────────────────────────────
 * 不开服务、不连网，只检查：
 *   1. 所有 JS 文件语法能过
 *   2. 两个包的依赖能 import
 *   3. 关键功能冒烟（唤醒判定 / 记忆读写 / 拟人化切分）
 *   4. 有没有漏进来的个人数据（QQ 号 / 密钥 / 本地路径）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0, warn = 0;

function ok(msg) { console.log('  ✅ ' + msg); pass++; }
function bad(msg) { console.log('  ❌ ' + msg); fail++; }
function wrn(msg) { console.log('  ⚠️  ' + msg); warn++; }
function head(msg) { console.log('\n▸ ' + msg); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);

// ── ① 语法 ─────────────────────────────────────────────────────
head('语法检查');
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
for (const f of jsFiles) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
    ok(path.relative(ROOT, f));
  } catch (e) {
    bad(path.relative(ROOT, f) + ' → ' + String(e.stderr || e.message).split('\n')[0]);
  }
}

// ── ② 能 import ────────────────────────────────────────────────
head('模块导入');
try {
  const lib = await import(path.join(ROOT, 'packages/companion/src/lib.js').replace(/\\/g, '/').replace(/^/, 'file:///'));
  const need = ['Memory', 'Role', 'Brain', 'Humanizer', 'Waker'];
  for (const n of need) {
    if (typeof lib[n] === 'function') ok('companion 导出 ' + n);
    else bad('companion 缺 ' + n);
  }
} catch (e) {
  bad('companion import 失败：' + (e?.message || e));
}

// ── ③ 功能冒烟 ─────────────────────────────────────────────────
head('功能冒烟');
try {
  const { Memory, Humanizer, Waker } = await import(
    path.join(ROOT, 'packages/companion/src/lib.js').replace(/\\/g, '/').replace(/^/, 'file:///')
  );

  // 唤醒
  const w = new Waker({ names: ['小鱼'], ownerIds: ['10001'] });
  const cases = [
    ['被 @', { key: 'group:1', userId: '2', text: 'hi', isAtMe: true }, true],
    ['叫名字', { key: 'group:1', userId: '2', text: '小鱼在吗' }, true],
    ['主人', { key: 'group:1', userId: '10001', text: '在吗' }, true],
    ['无关', { key: 'group:1', userId: '2', text: '今天天气不错' }, false],
  ];
  for (const [label, msg, want] of cases) {
    const got = w.shouldWake(msg).wake;
    if (got === want) ok('唤醒「' + label + '」→ ' + (got ? '醒' : '静音'));
    else bad('唤醒「' + label + '」期望 ' + want + ' 实际 ' + got);
  }

  // 拟人化
  const h = new Humanizer();
  const parts = h.split('第一条。第二条。第三条。');
  if (Array.isArray(parts) && parts.length > 0) ok('切分 → ' + parts.length + ' 条');
  else bad('切分异常');
  const ms = h.typingMsFor('你好啊');
  if (ms >= 1200 && ms <= 12000) ok('打字时长 ' + ms + 'ms（合理）');
  else bad('打字时长异常：' + ms);

  // 记忆
  const tmp = path.join(ROOT, '.tmp-check');
  fs.rmSync(tmp, { recursive: true, force: true });
  const mem = new Memory({ dir: tmp });
  mem.remember('10002', { name: '张三', trait: '常熬夜', fact: '养了只猫' });
  mem.logTurn({ where: 'private:10002', who: '张三', text: '在吗', reply: '在的' });
  const block = mem.renderPerson('10002');
  if (block.includes('常熬夜') && block.includes('养了只猫')) ok('账本读写正常');
  else bad('账本异常');
  const recent = mem.renderRecent(5);
  if (recent.includes('在吗')) ok('对话流正常');
  else bad('对话流异常');
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  bad('冒烟失败：' + (e?.stack || e));
}

// ── ④ 脱敏检查 ─────────────────────────────────────────────────
head('脱敏检查（不该出现的东西）');
const PATTERNS = [
  [/\b\d{10,11}\b/, '疑似 QQ 号（10~11 位数字）'],
  [/sk-[a-zA-Z0-9]{20,}/, '疑似 API key'],
  (/[A-Z]:\\\\?(Users|ai|qq-bridge|platform-tools|Comfy)/i, '疑似本机绝对路径'),
];
const ALLOW = [
  'scripts/check.mjs',       // 本文件自己写了这些模式
  'README.md',               // 文档里可能举例
];
let dirty = 0;
for (const f of files) {
  if (!/\.(js|mjs|json|md|yml|yaml|txt)$/.test(f)) continue;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (ALLOW.includes(rel)) continue;
  const txt = fs.readFileSync(f, 'utf8');
  for (const [re, label] of PATTERNS) {
    const m = txt.match(re);
    if (m) {
      wrn(rel + ' 命中「' + label + '」：' + m[0].slice(0, 40));
      dirty++;
    }
  }
}
if (!dirty) ok('没有发现个人数据 / 密钥 / 本机路径');

// ── 汇总 ───────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log('  通过 ' + pass + ' · 失败 ' + fail + ' · 警告 ' + warn);
if (fail) { console.log('  ❌ 有失败项'); process.exit(1); }
console.log('  ✅ 全部通过');
