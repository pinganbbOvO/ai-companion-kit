// phone-mcp · 安卓手机/模拟器控制 MCP 服务器（stdio）
//
// 用法：
//   1) 手机开启「开发者选项 → 无线调试」（Android 11+），或用 USB 连接
//   2) npx phone-mcp            （自动探测 adb 与设备）
//   3) 在任意支持 MCP 的客户端里配置它
//
// 环境变量（都可选）：
//   PHONE_ADB         adb 可执行文件路径（默认自动探测 PATH / 常见安装位置）
//   PHONE_SERIAL      设备序列号（默认选第一个已连接设备）
//   PHONE_SHOT_DIR    截图输出目录（默认 系统临时目录/phone-mcp-shots）
//   PHONE_MACRO_FILE  宏存储文件（默认 用户目录/.phone-mcp/macros.json）
//   PHONE_FFMPEG      ffmpeg 路径（默认自动探测，仅 video_frames 需要）
//
// 设计要点：
// - 只依赖本机 adb；手机侧无需安装任何 APP。
// - 中文输入走 ADBKeyboard（可选安装）；未装时会明确提示，不静默失败。
// - 所有 adb 调用都带超时，避免挂死。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as ncm from './ncm.js';

const execFileAsync = promisify(execFile);

// ── 可选配置（不填也能用，只是部分工具需要）──
const OWNER_MUSIC_UID = process.env.PHONE_MUSIC_OWNER_UID || '';

// ── 路径：全部自动探测，可用环境变量覆盖 ──
function findAdb() {
  if (process.env.PHONE_ADB) return process.env.PHONE_ADB;
  const cands = [];
  if (process.env.ANDROID_HOME) cands.push(path.join(process.env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (process.env.ANDROID_SDK_ROOT) cands.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (process.platform === 'win32') {
    cands.push('C:\\platform-tools\\adb.exe', 'C:\\adb\\adb.exe', 'D:\\platform-tools\\adb.exe');
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  } else {
    cands.push('/usr/local/bin/adb', '/usr/bin/adb', path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'));
  }
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'adb';   // 交给 PATH
}
const ADB = findAdb();
const SHOT_DIR = process.env.PHONE_SHOT_DIR || path.join(os.tmpdir(), 'phone-mcp-shots');
// 默认设备：留空 = 自动选第一个已连接设备（可用 PHONE_SERIAL 固定到某一台）
let SERIAL = process.env.PHONE_SERIAL || '';

async function adb(args, { timeout = 30000, serial = true } = {}) {
  const full = serial && SERIAL ? ['-s', SERIAL, ...args] : args;
  try {
    const { stdout, stderr } = await execFileAsync(ADB, full, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, out: String(stdout ?? ''), err: String(stderr ?? '') };
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? e) };
  }
}

async function ensureDevice() {
  if (SERIAL) return SERIAL;
  const r = await adb(['devices'], { serial: false });
  const lines = r.out.split(/\r?\n/).slice(1).filter((l) => l.trim());
  const ready = lines.map((l) => l.split(/\s+/)).filter((p) => p[1] === 'device').map((p) => p[0]);
  if (!ready.length) {
    throw new Error('没有已连接的设备。先让手机开启「无线调试」，再用 phone_pair / phone_connect。');
  }
  SERIAL = ready[0];
  return SERIAL;
}

async function shell(cmd, timeout = 30000) {
  await ensureDevice();
  const r = await adb(['shell', cmd], { timeout });
  if (!r.ok) throw new Error(`adb shell 失败：${r.err || r.out}`);
  return r.out;
}

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

const server = new McpServer({ name: 'phone', version: '0.1.0' });

server.tool(
  'music_lyrics',
  '查一首歌的歌词（网易云公开接口）。想跟主人聊他正在听的歌、或者想引一句歌词时用它。给歌名就行，歌手可选。',
  {
    song: z.string().describe('歌名，例如「遐想」'),
    artist: z.string().optional().describe('歌手名（可选，用来在同名歌里挑准的那首）'),
  },
  async ({ song, artist }) => {
    const UA = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://music.163.com/',
    };
    const q = artist ? `${song} ${artist}` : song;
    let songs = [];
    try {
      const r = await fetch(
        `https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=6`,
        { headers: UA }
      );
      const j = await r.json();
      songs = (j && j.result && j.result.songs) || [];
    } catch (e) {
      return fail(`搜歌失败：${e && e.message ? e.message : e}`);
    }
    if (!songs.length) return text(`没搜到「${q}」这首歌，换个写法试试（比如只给歌名）。`);
    // 挑最像的：名字完全相等优先，其次名字包含
    const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();
    const target = norm(song);
    let best = songs[0];
    for (const s of songs) {
      if (norm(s.name) === target) { best = s; break; }
      if (norm(s.name).includes(target) && norm(best.name) !== target) best = s;
    }
    const id = best.id;
    let lrc = '';
    try {
      const r2 = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, { headers: UA });
      const j2 = await r2.json();
      lrc = (j2 && j2.lrc && j2.lrc.lyric) || '';
    } catch (e) {
      return fail(`拉歌词失败：${e && e.message ? e.message : e}`);
    }
    if (!lrc.trim()) return text(`《${best.name}》找到了（id=${id}），但这首没有歌词（纯音乐或者没上传歌词）。`);
    // 去掉时间轴、去掉空行，最多 40 行
    const lines = lrc
      .split(/\r?\n/)
      .map((l) => l.replace(/^\[[^\]]*\]\s*/g, '').trim())
      .filter((l) => l && !/^作词|^作曲|^编曲|^制作人|^出品|^混音|^母带|^录音|^吉他|^贝斯|^鼓|^键盘|^和声|^监制|^统筹|^企划|^OP|^SP|^发行/.test(l))
      .slice(0, 40);
    const who = (best.artists || []).map((a) => a.name).join('/');
    return text(
      `《${best.name}》 - ${who}（id=${id}）\n` +
        `歌词（前 ${lines.length} 句）：\n${lines.join('\n')}\n\n` +
        `（想聊哪一句就直接引出来，别整段念。）`
    );
  }
);

// ── 网易云 PC 版（CDP + 内部 store） ────────────────────────────────────────
server.tool(
  'ncm_now',
  '看主人现在在网易云听什么：歌名/歌手/进度/是否在播放/正在唱的那一句歌词。这是你的"耳朵"——聊歌、接歌词、说"你在听这首啊"都用它。',
  {},
  async () => {
    try {
      const r = await ncm.earsReport();
      if (!r.ok) return text(r.error || '读不到播放状态。');
      const mm = Math.floor((r.duration || 0) / 60);
      const ss = Math.round((r.duration || 0) % 60);
      let s = `主人现在在听：《${r.title}》- ${r.artist}`;
      if (r.album) s += `（专辑《${r.album}》）`;
      if (r.duration) s += ` 全长 ${mm}:${String(ss).padStart(2, '0')}`;
      s += r.playing ? '  ▶ 正在播放' : '  ⏸ 暂停中';
      if (r.currentLine) s += `\n正在唱的这一句：「${r.currentLine}」`;
      if (r.nearby && r.nearby.length) {
        s += '\n前后几句：\n' + r.nearby.map((l) => (l.current ? '  ▶ ' : '    ') + l.text).join('\n');
      }
      return text(s);
    } catch (e) {
      return fail('读播放状态失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_room',
  '看网易云「一起听」房间状态：在不在房间里、房间里还有谁、一起听了多久、房间歌单几首。',
  {},
  async () => {
    try {
      const r = await ncm.roomState();
      if (!r.roomId) return text('现在没在「一起听」房间里（status=' + (r.status || '?') + '）。');
      const others = (r.members || []).filter((m) => String(m.id) !== String(r.creatorId));
      return text(
        `在「一起听」房间里 ✓\n` +
          `  房间号：${r.roomId}\n` +
          `  房主 id：${r.creatorId}\n` +
          `  成员：${(r.members || []).map((m) => m.name || m.id).join('、') || '（读不到名字）'}\n` +
          `  一起听了 ${Math.round((r.totalSec || 0) / 60)} 分钟（第 ${r.listenCount || 0} 次）\n` +
          `  歌单：${r.songCount || 0} 首`
      );
    } catch (e) {
      return fail('读房间失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_control',
  '控制网易云 PC 版的播放：play 继续 / pause 暂停 / next 下一首 / previous 上一首。',
  { command: z.enum(['play', 'pause', 'next', 'previous']).describe('要执行的命令') },
  async ({ command }) => {
    try {
      await ncm.control(command);
      return text('已执行：' + command);
    } catch (e) {
      return fail('控制失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_room_control',
  '在「一起听」房间里控制同步播放：PLAY 继续 / PAUSE 暂停 / NEXT 下一首（需要 ids=[前一首id,目标id]）/ GOTO 跳转。房间里的两个人会一起变。',
  {
    command: z.enum(['PLAY', 'PAUSE', 'NEXT', 'PREVIOUS', 'GOTO']).describe('房间命令'),
    ids: z.array(z.string()).optional().describe('NEXT/PREVIOUS/GOTO 需要：[当前歌曲id, 目标歌曲id]'),
    position: z.number().optional().describe('GOTO 时的秒数'),
  },
  async ({ command, ids, position }) => {
    try {
      await ncm.roomControl(command, { ids: ids || null, position: position == null ? null : position });
      return text('房间命令已发：' + command);
    } catch (e) {
      return fail('房间控制失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_play',
  '让 PC 版网易云播放指定的歌（本地播放，不走房间）：给歌名就行，歌手可选，或者直接给 songId。',
  {
    song: z.string().optional().describe('歌名'),
    artist: z.string().optional().describe('歌手（可选）'),
    songId: z.string().optional().describe('直接给网易云歌曲 id（可选，比歌名准）'),
  },
  async ({ song, artist, songId }) => {
    try {
      let id = songId ? String(songId) : '';
      let name = song || '';
      if (!id) {
        if (!song) return fail('至少给个歌名或者 songId。');
        const list = await ncm.search(artist ? song + ' ' + artist : song, 6);
        if (!list.length) return fail('没搜到「' + song + '」');
        const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();
        const want = norm(song);
        let best = list[0];
        for (const x of list) {
          if (norm(x.name) === want) { best = x; break; }
          if (norm(x.name).includes(want) && norm(best.name) !== want) best = x;
        }
        id = String(best.id);
        name = best.name;
      }
      const r = await ncm.playSong(id, name);
      return text(r.ok ? `已经在放了：《${name}》` : '没放成：' + (r.error || '未知原因'));
    } catch (e) {
      return fail('点歌失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_comments',
  '看某首歌的网易云评论（热评 + 最新）。想跟主人聊某首歌的风评、或者想找条有意思的评论念给他听时用。',
  {
    songId: z.string().describe('歌曲 id（可以用 ncm_search 或 music_lyrics 拿到）'),
    limit: z.number().optional().describe('各取几条，默认 5'),
  },
  async ({ songId, limit }) => {
    try {
      const n = Math.max(1, Math.min(20, Number(limit) || 5));
      const c = await ncm.comments(songId, n, 0);
      const fmt = (arr, head) =>
        arr.length ? head + '\n' + arr.map((x) => `  ${x.user}（${x.likes}赞）：${String(x.text).replace(/\n/g, ' ').slice(0, 120)}`).join('\n') : '';
      return text(`这首歌共 ${c.total} 条评论\n` + [fmt(c.hot, '【热评】'), fmt(c.latest, '【最新】')].filter(Boolean).join('\n'));
    } catch (e) {
      return fail('读评论失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_search',
  '在网易云搜歌，返回 id 和歌名歌手。点歌、查歌词、看评论之前先用它拿 id。',
  {
    keyword: z.string().describe('搜索词，歌名或者"歌名 歌手"'),
    limit: z.number().optional().describe('返回几条，默认 6'),
  },
  async ({ keyword, limit }) => {
    try {
      const list = await ncm.search(keyword, Math.max(1, Math.min(20, Number(limit) || 6)));
      if (!list.length) return text('没搜到。');
      return text(list.map((x) => `${x.id}  ${x.name} - ${x.artist}${x.album ? ' 《' + x.album + '》' : ''}`).join('\n'));
    } catch (e) {
      return fail('搜索失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_inbox',
  '看主人在网易云给你发的私信（借客户端的手读，不需要密码）。他在网易云里发给你的话，用这个就能看到。',
  {
    userId: z.string().optional().describe('对方的网易云数字 id（可选，默认取配置里的 ownerMusicUid）'),
    limit: z.number().optional().describe('看几条，默认 10'),
  },
  async ({ userId, limit }) => {
    try {
      const who = String(userId || OWNER_MUSIC_UID || '');
      const n = Math.max(1, Math.min(30, Number(limit) || 10));
      const r = await ncm.inbox(who, n);
      if (!r.ok) return fail('读私信失败：' + JSON.stringify(r).slice(0, 200));
      if (!r.list.length) return text('（还没有私信。你在网易云里发给主人的话会出现在这里。）');
      return text(
        r.list
          .map((x) => `[${new Date((x.time || 0)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}] ${x.self ? '你' : x.fromNick || x.from}：${x.text}`)
          .join('\n')
      );
    } catch (e) {
      return fail('读私信失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_msg_users',
  '列出你的网易云私信会话（都有谁给你发过消息）。',
  {},
  async () => {
    try {
      const r = await ncm.msgUsers(20);
      if (!r.ok) return fail('读会话列表失败：' + JSON.stringify(r).slice(0, 200));
      if (!r.list.length) return text('（还没有任何私信会话。）');
      return text(r.list.map((x) => `${x.userId}  ${x.nick || '(无昵称)'}：${x.last}`).join('\n'));
    } catch (e) {
      return fail('读会话列表失败：' + (e && e.message ? e.message : e));
    }
  }
);


// ── ROOM_SAY_V3：快速版（聊天框已开就只打字+发送 ✗ ~8 秒） ──────────────────
const ROOM_EMU = process.env.ROOM_EMU_SERIAL || 'emulator-5554';
const EMU_SHOT_DIR = SHOT_DIR;
const SELF_MUSIC_UID = process.env.PHONE_MUSIC_SELF_UID || '';

async function emuAdb(args, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileAsync(ADB, ['-s', ROOM_EMU, ...args], {
      timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    return { ok: true, out: String(stdout ?? ''), err: String(stderr ?? '') };
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? e) };
  }
}
const emuSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ensureIme：确保 ADBKeyboard 是当前输入法（模拟器重启后会被重置 ✗ 这里自愈）──
let imeChecked = 0;
async function ensureIme(force = false) {
  const now = Date.now();
  if (!force && now - imeChecked < 60000) return true;   // 一分钟内不重复查
  const IME = 'com.android.adbkeyboard/.AdbIME';
  const cur = String((await adb(['shell', 'settings', 'get', 'secure', 'default_input_method'])).out || '').trim();
  if (cur === IME) { imeChecked = now; return true; }
  // 修：先启用 ✗ 再把列表和默认都设成它
  await adb(['shell', 'ime', 'enable', IME]);
  await adb(['shell', 'settings', 'put', 'secure', 'enabled_input_methods',
    IME + ':com.android.inputmethod.pinyin/.InputService']);
  await adb(['shell', 'settings', 'put', 'secure', 'default_input_method', IME]);
  await emuSleep(600);
  const after = String((await adb(['shell', 'settings', 'get', 'secure', 'default_input_method'])).out || '').trim();
  log ? log('[ime] 输入法 ' + cur + ' → ' + after) : null;
  imeChecked = Date.now();
  return after === IME;
}

const COMPOSER_INPUT = ['75', '639'];
const SEND_SPOTS = [['613', '627'], ['609', '623'], ['620', '623'], ['1219', '367']];
const CHAT_ENTRY_SPOTS = [['411', '478'], ['347', '467'], ['325', '487'], ['313', '495']];

// 键盘开着 = 聊天框开着（一次 dumpsys ✗ 约 0.4 秒）
async function composerOpen() {
  const r = await emuAdb(['shell', 'dumpsys', 'input_method']);
  return String(r.out).includes('mInputShown=true');
}

server.tool(
  'ncm_room_say',
  '在你们的一起听房间里说话 —— 用她自己的账号真发到房间聊天框里，主人手机上马上能看到。想陪他聊天、接歌词、吐槽切歌、说晚安时用它。注意：只有【他刚给你发过消息】时聊天框才打得开 ✓',
  { text: z.string().describe('要说的话，一到两句，短一点更自然') },
  async ({ text: say }) => {
    const msg = String(say || '').trim();
    if (!msg) return fail('要说的话不能为空。');
    if (msg.length > 120) return fail('太长了，房间里说话短一点（120 字以内）。');
    try {
      // ① 确认网易云在前台（不在就启动）
      const win = await emuAdb(['shell', 'dumpsys', 'window']);
      const fg = (String(win.out).match(/mCurrentFocus=(\S+)/) || [])[1] || '';
      if (!fg.includes('com.netease.cloudmusic')) {
        await emuAdb(['shell', 'input', 'keyevent', '3']);
        await emuSleep(1200);
        const act = await emuAdb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', 'com.netease.cloudmusic']);
        const comp = String(act.out || '').trim().split(/\r?\n/).pop().trim();
        if (comp && comp.includes('/')) await emuAdb(['shell', 'am', 'start', '-n', comp]);
        await emuSleep(13000);
      }
      // ② 进播放页
      await emuAdb(['shell', 'input', 'tap', '267', '653']);
      await emuSleep(4500);

      // ③ 依次试各个候选位置 ✗ 每次点完看看输入框有没有出现
      let opened = false;
      for (const spot of CHAT_ENTRY_SPOTS) {
        await emuAdb(['shell', 'input', 'tap', spot[0], spot[1]]);
        await emuSleep(2500);
        // 点完试探一下：点输入框位置 ✗ 再截图看有没有键盘（键盘弹出会让屏幕变矮 ✓）
        await emuAdb(['shell', 'input', 'tap', COMPOSER_INPUT[0], COMPOSER_INPUT[1]]);
        await emuSleep(1200);
        const kb = await emuAdb(['shell', 'dumpsys', 'input_method']);
        if (String(kb.out).includes('mInputShown=true')) { opened = true; break; }
      }
      if (!opened) {
        // 打不开就诚实告诉她 ✗ 别假装成功
        return fail('房间聊天框打不开（他可能还没给你发新消息 ✗ 聊天框只在有未读时出现）。' +
          '这次就别在房间里发了 ✗ 直接用 QQ 回他 ✓');
      }

      // ④ 打中文
      await emuAdb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', msg]);
      await emuSleep(2200);

      // ⑤ 点发送（键盘弹出时和收起时位置不同 ✗ 两个都点）
      await emuAdb(['shell', 'input', 'tap', '1219', '367']);
      await emuSleep(1500);
      await emuAdb(['shell', 'input', 'tap', '613', '627']);
      await emuSleep(2500);

      // ⑥ 截图自检
      try { await emuAdb(['shell', 'mkdir', '-p', '/sdcard/_shots']); } catch {}
      await emuAdb(['shell', 'screencap', '-p', '/sdcard/_roomsay.png']);
      try { await emuAdb(['pull', '/sdcard/_roomsay.png', EMU_SHOT_DIR + '\\roomsay.png']); } catch {}
      return text('已经在房间里说了：「' + msg + '」\n（截图: ' + EMU_SHOT_DIR + '\\roomsay.png ✗ 可以看图确认有没有真发出去 ✓）');
    } catch (e) {
      return fail('发到房间失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'phone_macro',
  '★连招★ 一次调用执行一串手机动作（点按 / 滑动 / 长按 / 按键 / 等待）——玩游戏、刷视频、重复操作时用这个，比一个个调 phone_tap 快几十倍。每条动作之间会自动等一小会儿，你也可以用 sleep 自己插延迟。',
  {
    actions: z.array(z.object({
      type: z.enum(['tap', 'swipe', 'longpress', 'key', 'sleep', 'text']).describe('动作类型'),
      x: z.number().optional().describe('tap/longpress 的 x 坐标'),
      y: z.number().optional().describe('tap/longpress 的 y 坐标'),
      x2: z.number().optional().describe('swipe 终点 x'),
      y2: z.number().optional().describe('swipe 终点 y'),
      ms: z.number().optional().describe('longpress 时长 / sleep 毫秒 / swipe 滑动时长（默认 200）'),
      key: z.string().optional().describe('key 动作：back/home/enter/recent/volume_up/volume_down/power/delete'),
      text: z.string().optional().describe('text 动作：要输入的文本（支持中文 ✗ 需装 ADBKeyboard ✓）')
    })).min(1).max(200).describe('动作列表，按顺序执行'),
    stepMs: z.number().optional().describe('每个动作之后默认等待毫秒（默认 400 ✗ 玩游戏可调小到 150）'),
    repeat: z.number().optional().describe('★整套动作重复几次（默认 1 ✗ 最多 200）✗ 玩游戏刷同一套操作时用它，只花一次调用'),
    repeatGapMs: z.number().optional().describe('每次重复之间的等待毫秒（默认 300 ✗ 打怪可以 100）'),
    saveAs: z.string().optional().describe('★把这套动作存成命名的宏（下次用 playName 一键放）✗ 名字用英文/数字/下划线'),
    playName: z.string().optional().describe('★播放之前存过的宏（这时 actions 可以不传）'),
    listMacros: z.boolean().optional().describe('列出所有存过的宏'),
    screenshot: z.boolean().optional().describe('最后是否截图（默认 true ✗ 玩游戏想快就传 false）')
  },
  async ({ actions, stepMs = 400, repeat = 1, repeatGapMs = 300, screenshot = true, saveAs, playName, listMacros }) => {
    await ensureDevice();
    // ── 命名宏存取（存在 state/phone-macros.json）──
    const MACRO_FILE = process.env.PHONE_MACRO_FILE || path.join(os.homedir(), '.phone-mcp', 'macros.json');
    const loadMacros = () => { try { return JSON.parse(fs.readFileSync(MACRO_FILE, 'utf8')); } catch { return {}; } };
    const saveMacros = (m) => { try { fs.mkdirSync(path.dirname(MACRO_FILE), { recursive: true }); fs.writeFileSync(MACRO_FILE, JSON.stringify(m, null, 2), 'utf8'); } catch {} };

    if (listMacros) {
      const m = loadMacros();
      const names = Object.keys(m);
      if (!names.length) return text('还没有存过任何宏 ✗ 用 saveAs 存一个吧 ✓');
      return text('存过的宏（' + names.length + ' 个）✗\n' + names.map((n) => '· ' + n + '（' + (m[n].actions || []).length + ' 个动作' + (m[n].note ? ' ✗ ' + m[n].note : '') + '）').join('\n'));
    }
    if (playName) {
      const m = loadMacros();
      const hit = m[String(playName).trim()];
      if (!hit) return fail('没有叫「' + playName + '」的宏 ✗ 用 listMacros 看看有哪些 ✓');
      actions = hit.actions;
      if (hit.stepMs && stepMs === 400) stepMs = hit.stepMs;
      log('[macro] 播放宏 ' + playName + '（' + actions.length + ' 个动作 × ' + repeat + '）');
    }
    if (saveAs) {
      const nm = String(saveAs).trim().replace(/[^\w\-]/g, '_').slice(0, 40);
      if (!nm) return fail('saveAs 名字不合法');
      const m = loadMacros();
      m[nm] = { actions: actions || [], stepMs, savedAt: new Date().toISOString() };
      saveMacros(m);
      log('[macro] 已存宏 ' + nm + '（' + (actions || []).length + ' 个动作）');
      return text('已存成宏「' + nm + '」✗ 以后用 phone_macro({playName:"' + nm + '", repeat:N}) 一键放 ✓');
    }
    if (!Array.isArray(actions) || !actions.length) {
      return fail('要么给 actions ✗ 要么用 playName 放一个存过的宏（listMacros 看列表）');
    }
    const done = [];
    const t0 = Date.now();
    try {
      const rounds = Math.max(1, Math.min(200, Math.round(Number(repeat) || 1)));
      for (let round = 0; round < rounds; round++) {
      if (round > 0 && repeatGapMs > 0) {
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10000, repeatGapMs))));
      }
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const type = String(a.type || '');
        if (type === 'sleep') {
          const ms = Math.max(10, Math.min(30000, Number(a.ms ?? 500)));
          await new Promise((r) => setTimeout(r, ms));
          done.push('sleep ' + ms);
          continue;
        }
        if (type === 'tap') {
          if (a.x == null || a.y == null) throw new Error('tap 需要 x/y');
          await adb(['shell', 'input', 'tap', String(Math.round(a.x)), String(Math.round(a.y))]);
          done.push('tap(' + Math.round(a.x) + ',' + Math.round(a.y) + ')');
        } else if (type === 'longpress') {
          if (a.x == null || a.y == null) throw new Error('longpress 需要 x/y');
          const ms = Math.max(300, Math.min(10000, Number(a.ms ?? 800)));
          // adb 没有原生长按 ✗ 用 swipe 原地划（起点=终点 ✗ 时长=按压时长）
          await adb(['shell', 'input', 'swipe', String(Math.round(a.x)), String(Math.round(a.y)),
            String(Math.round(a.x)), String(Math.round(a.y)), String(ms)]);
          done.push('longpress(' + Math.round(a.x) + ',' + Math.round(a.y) + ',' + ms + 'ms)');
        } else if (type === 'swipe') {
          if (a.x == null || a.y == null || a.x2 == null || a.y2 == null) throw new Error('swipe 需要 x/y/x2/y2');
          const ms = Math.max(50, Math.min(5000, Number(a.ms ?? 200)));
          await adb(['shell', 'input', 'swipe', String(Math.round(a.x)), String(Math.round(a.y)),
            String(Math.round(a.x2)), String(Math.round(a.y2)), String(ms)]);
          done.push('swipe(' + Math.round(a.x) + ',' + Math.round(a.y) + '→' + Math.round(a.x2) + ',' + Math.round(a.y2) + ')');
        } else if (type === 'key') {
          const k = String(a.key || '').trim();
          const allowed = ['back', 'home', 'enter', 'recent', 'volume_up', 'volume_down', 'power', 'delete'];
          if (!allowed.includes(k)) throw new Error('key 只能是: ' + allowed.join('/'));
          await adb(['shell', 'input', 'keyevent', k.toUpperCase()]);
          done.push('key ' + k);
        } else if (type === 'text') {
          const s = String(a.text ?? '');
          if (!s) throw new Error('text 不能为空');
          await ensureIme();
          await adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', s]);
          done.push('text(' + s.slice(0, 12) + ')');
        } else {
          throw new Error('未知动作类型: ' + type);
        }
        if (i < actions.length - 1 && stepMs > 0) {
          await new Promise((r) => setTimeout(r, Math.max(0, Math.min(5000, stepMs))));
        }
      }
      }
      const sec = ((Date.now() - t0) / 1000).toFixed(2);
      let shotLine = '';
      if (screenshot) {
        const shot = await adb(['shell', 'screencap', '-p', '/sdcard/_macro.png']);
        const pull = await adb(['pull', '/sdcard/_macro.png', path.join(SHOT_DIR, 'macro.png')], { timeout: 30000 });
        await adb(['shell', 'rm', '/sdcard/_macro.png']);
        shotLine = (shot.ok && pull.ok) ? ('\n截图: ' + path.join(SHOT_DIR, 'macro.png')) : '\n（截图失败 ✗）';
      }
      return text('连招执行完 ✗ ' + actions.length + ' 个动作 ✗ 耗时 ' + sec + ' 秒\n' +
        done.slice(0, 40).join(' → ') + (done.length > 40 ? ' …' : '') + shotLine);
    } catch (e) {
      return fail('连招中断在第 ' + (done.length + 1) + ' 个动作：' + (e && e.message ? e.message : e) +
        '\n已完成: ' + done.join(' → '));
    }
  }
);

server.tool('phone_status', '查看 adb 是否可用、当前连接了哪些设备。', {}, async () => {
  const v = await adb(['version'], { serial: false });
  const d = await adb(['devices', '-l'], { serial: false });
  return text(
    `adb: ${v.ok ? v.out.split(/\r?\n/)[0] : '不可用 ' + v.err}\n` +
      `adb 路径: ${ADB}\n` +
      `当前设备:\n${d.out || d.err}\n` +
      `已选中: ${SERIAL || '（未选，将用第一台）'}`
  );
});

server.tool(
  'phone_pair',
  '首次配对你的手机：在手机「无线调试 → 使用配对码配对设备」里看到 6 位配对码和 ip:端口，把它们填进来。只需做一次。',
  {
    host: z.string().describe('配对用的 IP（手机屏幕上显示的那个）'),
    port: z.string().describe('配对用的端口（配对弹窗里显示的，通常不是 5555）'),
    code: z.string().describe('6 位配对码'),
  },
  async ({ host, port, code }) => {
    const r = await adb(['pair', `${host}:${port}`, code], { timeout: 60000, serial: false });
    return r.ok && /Successfully paired/i.test(r.out) ? text(`配对成功 ✓\n${r.out}`) : fail(`配对失败：${r.err || r.out}`);
  }
);

server.tool(
  'phone_connect',
  '连接手机（无线调试里的 ip:端口，例如 192.168.1.98:5555）。连上后本机就能控制它。',
  {
    host: z.string().describe('手机 IP'),
    port: z.string().default('5555').describe('调试端口，默认 5555'),
  },
  async ({ host, port }) => {
    const r = await adb(['connect', `${host}:${port}`], { timeout: 60000, serial: false });
    if (!/connected to/i.test(r.out)) return fail(`连接失败：${r.err || r.out}`);
    SERIAL = `${host}:${port}`;
    const sz = await shell('wm size');
    return text(`已连接 ${SERIAL} ✓\n屏幕: ${sz.trim()}`);
  }
);

server.tool('phone_devices', '列出所有 adb 设备，并可直接切换当前使用的设备。', {
  use: z.string().optional().describe('要切换到的设备序列号（可选）'),
}, async ({ use }) => {
  const d = await adb(['devices', '-l'], { serial: false });
  if (use) SERIAL = use;
  return text(`${d.out}\n当前选中: ${SERIAL || '（自动选第一台）'}`);
});

server.tool('phone_screenshot', '给手机截屏并存成 PNG，返回文件路径（可直接看图）。', {
  note: z.string().optional().describe('文件名备注，可选'),
}, async ({ note }) => {
  try {
    await ensureDevice();
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const local = path.join(SHOT_DIR, `shot-${stamp}${note ? '-' + note.replace(/[^\w-]/g, '') : ''}.png`);
    const remote = '/sdcard/_dsh_shot.png';
    await shell(`screencap -p ${remote}`);
    const pull = await adb(['pull', remote, local], { timeout: 60000 });
    if (!pull.ok || !fs.existsSync(local)) return fail(`拉取截图失败：${pull.err || pull.out}`);
    const bytes = fs.statSync(local).size;
    const content = [{ type: 'text', text: `截图已保存: ${local} (${bytes} 字节)` }];
    if (bytes > 0 && bytes < 4 * 1024 * 1024) {
      content.push({ type: 'image', data: fs.readFileSync(local).toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  } catch (e) {
    return fail(`截图失败：${e?.message ?? e}`);
  }
});

server.tool('phone_dump', '导出手机当前的界面结构，解析成「可点元素清单」（文字/类型/中心坐标）。适合先 dump 再 tap。', {
  max: z.number().int().min(1).max(200).default(60).describe('最多返回多少个元素'),
}, async ({ max }) => {
  try {
    await ensureDevice();
    const remote = '/sdcard/_dsh_ui.xml';
    await shell(`uiautomator dump ${remote}`);
    const r = await adb(['shell', 'cat', remote], { timeout: 60000 });
    const xml = r.out;
    const items = [];
    const re = /<node[^>]*>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const tag = m[0];
      const get = (k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
      const t = get('text') || get('content-desc');
      const cls = (get('class') || '').split('.').pop();
      const clickable = get('clickable') === 'true';
      const bounds = get('bounds');
      const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!bm) continue;
      const [, x1, y1, x2, y2] = bm.map(Number);
      if (!t && !clickable) continue;
      items.push({
        text: t.slice(0, 40),
        type: cls,
        clickable,
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
      });
      if (items.length >= max) break;
    }
    const lines = items.map((i, idx) => `${idx}: ${i.clickable ? '[可点]' : '[只读]'} ${i.type} "${i.text}" @(${i.x},${i.y})`);
    return text(`共 ${items.length} 个元素：\n${lines.join('\n')}`);
  } catch (e) {
    return fail(`dump 失败：${e?.message ?? e}`);
  }
});

server.tool('phone_tap', '点击手机屏幕上的坐标（配合 phone_dump 得到的 x,y）。', {
  x: z.number().int().describe('横坐标'),
  y: z.number().int().describe('纵坐标'),
}, async ({ x, y }) => {
  try {
    await shell(`input tap ${x} ${y}`);
    return text(`已点击 (${x}, ${y})`);
  } catch (e) {
    return fail(`点击失败：${e?.message ?? e}`);
  }
});

server.tool('phone_tap_text', '按界面上显示的文字/描述找到元素并点击（比坐标稳，推荐）。', {
  text: z.string().describe('要点击的文字或描述，可只写一部分'),
  index: z.number().int().min(0).default(0).describe('匹配到多个时点第几个，默认 0'),
}, async ({ text: want, index }) => {
  try {
    await ensureDevice();
    const remote = '/sdcard/_dsh_ui.xml';
    await shell(`uiautomator dump ${remote}`);
    const r = await adb(['shell', 'cat', remote], { timeout: 60000 });
    const hits = [];
    const re = /<node[^>]*>/g;
    let m;
    while ((m = re.exec(r.out)) !== null) {
      const tag = m[0];
      const get = (k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
      const t = get('text') || get('content-desc');
      if (!t || !t.includes(want)) continue;
      const bm = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!bm) continue;
      const [, x1, y1, x2, y2] = bm.map(Number);
      hits.push({ t, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) });
    }
    if (!hits.length) return fail(`界面上找不到包含「${want}」的元素`);
    const hit = hits[Math.min(index, hits.length - 1)];
    await shell(`input tap ${hit.x} ${hit.y}`);
    return text(`已点击「${hit.t}」@(${hit.x},${hit.y})  匹配 ${hits.length} 个`);
  } catch (e) {
    return fail(`点击失败：${e?.message ?? e}`);
  }
});

server.tool('phone_text', '往当前输入框打字（支持中文，需手机装有 ADBKeyboard 输入法；纯英文数字无需）。', {
  text: z.string().describe('要输入的文字'),
}, async ({ text: content }) => {
  try {
    await ensureDevice();
    const has = await shell('ime list -a');
    const hasAdbKb = /com\.android\.adbkeyboard/i.test(has);
    const ascii = /^[\x20-\x7e]*$/.test(content);
    if (ascii) {
      await shell(`input text '${content.replace(/'/g, "'\\''")}'`);
      return text(`已输入（ADB 原生）: ${content}`);
    }
    if (!hasAdbKb) {
      return fail(
        '这段文字含中文，需要手机安装 ADBKeyboard 输入法（开源，一次性装好即可）。\n' +
          '装好后重试；或改用纯英文/数字。'
      );
    }
    // ★ 雷电/安卓14 上【ime set 永远失败】✗ 必须用 settings put secure ✓
    const cur = (await shell('settings get secure default_input_method')).trim();
    const IME = 'com.android.adbkeyboard/.AdbIME';
    await shell(`ime enable ${IME}`);
    await shell(`settings put secure enabled_input_methods "${IME}:${cur || 'com.android.inputmethod.pinyin/.InputService'}"`);
    await shell(`settings put secure default_input_method ${IME}`);
    await new Promise((r) => setTimeout(r, 600));
    await shell(`am broadcast -a ADB_INPUT_TEXT --es msg '${content.replace(/'/g, "'\\''")}'`);
    // 切回原来的输入法（她不用的时候保持正常）
    if (cur && cur !== IME) await shell(`settings put secure default_input_method ${cur}`);
    return text(`已输入（ADBKeyboard）: ${content}`);
  } catch (e) {
    return fail(`输入失败：${e?.message ?? e}`);
  }
});

server.tool('phone_key', '按手机按键：back / home / enter / recent / volume_up / volume_down / power / delete。', {
  key: z.enum(['back', 'home', 'enter', 'recent', 'volume_up', 'volume_down', 'power', 'delete', 'menu']),
}, async ({ key }) => {
  const map = {
    back: 4, home: 3, enter: 66, recent: 187, volume_up: 24, volume_down: 25, power: 26, delete: 67, menu: 82,
  };
  try {
    await shell(`input keyevent ${map[key]}`);
    return text(`已按下 ${key}`);
  } catch (e) {
    return fail(`按键失败：${e?.message ?? e}`);
  }
});

server.tool('phone_swipe', '滑动屏幕（例如从下往上滑返回桌面、下拉通知栏等）。', {
  x1: z.number().int(), y1: z.number().int(),
  x2: z.number().int(), y2: z.number().int(),
  ms: z.number().int().min(50).max(3000).default(300).describe('滑动耗时毫秒'),
}, async ({ x1, y1, x2, y2, ms }) => {
  try {
    await shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
    return text(`已滑动 (${x1},${y1}) → (${x2},${y2})`);
  } catch (e) {
    return fail(`滑动失败：${e?.message ?? e}`);
  }
});

server.tool('phone_open_app', '按包名或关键字启动一个 App（例如 com.tencent.mm 微信）。', {
  pkg: z.string().describe('包名或关键字')
}, async ({ pkg }) => {
  await ensureDevice();
  const target = String(pkg || '').trim();
  if (!target) return fail('要启动什么？给包名或关键字。');
  // RAW_ADB_OK：am start 有时返回非零但仍然成功 ✗ 所以这里不用会抛异常的 shell()
  const run = async (cmd) => {
    const r = await adb(['shell', cmd], { timeout: 20000 });
    return String(r.out || '') + String(r.err || '');
  };
  let out = await run(`am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${target}`);
  const bad = (s) => /Error|not found|Exception|does not exist|Unable to/i.test(s);
  if (bad(out)) {
    // 兜底 1：拿启动组件直接起
    const comp = await run(`cmd package resolve-activity --brief ${target}`);
    const line = String(comp).trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (line.includes('/')) {
      out = await run(`am start -n ${line.trim()}`);
    }
    // 兜底 2：按关键字搜包名
    if (bad(out)) {
      const pkgs = await run(`pm list packages | grep -i ${target}`);
      const first = String(pkgs).split(/\r?\n/).map((s) => s.replace('package:', '').trim()).filter(Boolean)[0];
      if (first) {
        const comp2 = await run(`cmd package resolve-activity --brief ${first}`);
        const l2 = String(comp2).trim().split(/\r?\n/).filter(Boolean).pop() || '';
        if (l2.includes('/')) out = await run(`am start -n ${l2.trim()}`);
      }
    }
  }
  if (bad(out)) return fail('启动失败：' + out.slice(0, 200));
  return text('已启动 ' + target + '\n' + out.slice(0, 200));
});

// ── 看视频：抽帧成图片（LLM 不能直接看视频，但能"看"这一串画面）──────────────
// 允许的视频来源：截图目录/媒体目录里的文件、http(s) 链接；不允许任意本地路径。
// ffmpeg 优先用 PHONE_FFMPEG，其次用 ComfyUI 环境自带的静态版，最后退回 PATH 上的 ffmpeg。
const FFMPEG_CANDIDATES = [
  process.env.PHONE_FFMPEG,
  (process.env.PHONE_FFMPEG || 'ffmpeg'),
  'ffmpeg',
].filter(Boolean);

function findFfmpeg() {
  for (const c of FFMPEG_CANDIDATES) {
    try {
      if (c === 'ffmpeg' || fs.existsSync(c)) return c;
    } catch {}
  }
  return 'ffmpeg';
}

async function runFfmpeg(args, timeout = 120000) {
  const bin = findFfmpeg();
  return await new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? err?.message ?? '') });
    });
  });
}

server.tool(
  'video_frames',
  '看视频：把一段视频抽成若干张关键画面（图片），从而"看懂"里面的内容。支持本机允许目录里的视频文件或 http(s) 视频直链。',
  {
    video: z.string().describe('视频：允许目录里的文件名/绝对路径，或 http(s) 视频链接'),
    count: z.number().int().min(2).max(12).default(6).describe('抽几帧，默认 6'),
    startSec: z.number().min(0).default(0).describe('从第几秒开始抽，默认 0'),
    durationSec: z.number().min(0).default(0).describe('截取多长（0=整段，最多取 600 秒）'),
  },
  async ({ video, count, startSec, durationSec }) => {
    try {
      const r = resolveImage(video);
      if (r.error) return fail(String(r.error).replace('图片', '视频'));
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outDir = path.join(SHOT_DIR, 'frames-' + stamp);
      fs.mkdirSync(outDir, { recursive: true });
      const dur = durationSec > 0 ? Math.min(durationSec, 600) : 0;
      // 没给时长：先用 ffmpeg 探总时长，让 count 帧均匀铺满整段（探测失败退回每 4 秒一帧）。
      let probeDur = dur;
      if (probeDur <= 0) {
        const probe = await runFfmpeg(['-hide_banner', '-i', r.file], 30000);
        const mm = String(probe.err).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (mm) probeDur = Number(mm[1]) * 3600 + Number(mm[2]) * 60 + Number(mm[3]);
      }
      const fps = probeDur > 0 ? count / probeDur : 1 / 4;
      const args = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (startSec > 0) args.push('-ss', String(startSec));
      if (dur > 0) args.push('-t', String(dur));
      args.push('-i', r.file, '-vf', `fps=${fps.toFixed(4)},scale='min(720,iw)':-2`, '-frames:v', String(count), path.join(outDir, 'f%02d.jpg'));
      const res = await runFfmpeg(args);
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort();
      if (!files.length) {
        return fail(`抽帧失败（没有产出图片）：${res.err.slice(0, 300) || '未知原因'}  源：${r.file}`);
      }
      const content = [{ type: 'text', text: `已从视频抽出 ${files.length} 帧（时长${dur > 0 ? ' ' + dur + ' 秒' : ''}），目录：${outDir}` }];
      for (const f of files) {
        const p = path.join(outDir, f);
        const size = fs.statSync(p).size;
        if (size > 0 && size < 3 * 1024 * 1024) {
          content.push({ type: 'text', text: `第 ${f} 帧：` });
          content.push({ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType: 'image/jpeg' });
        }
      }
      return { content };
    } catch (e) {
      return fail(`看视频失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'phone_record_screen',
  '录一段手机屏幕（最多 60 秒），然后自动抽帧成图片返回 —— 用来"看"手机上发生的过程。',
  {
    seconds: z.number().int().min(1).max(60).default(10).describe('录多久，默认 10 秒'),
    frames: z.number().int().min(2).max(12).default(6).describe('抽几帧'),
  },
  async ({ seconds, frames }) => {
    try {
      await ensureDevice();
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const remote = '/sdcard/_dsh_rec.mp4';
      const local = path.join(SHOT_DIR, `rec-${stamp}.mp4`);
      await shell(`screenrecord --time-limit ${seconds} --bit-rate 4000000 ${remote}`, (seconds + 30) * 1000);
      const pull = await adb(['pull', remote, local], { timeout: 120000 });
      if (!pull.ok || !fs.existsSync(local)) return fail(`录屏拉取失败：${pull.err || pull.out}`);
      const outDir = path.join(SHOT_DIR, 'recframes-' + stamp);
      fs.mkdirSync(outDir, { recursive: true });
      const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', local,
        '-vf', `fps=${(frames / Math.max(1, seconds)).toFixed(4)},scale='min(720,iw)':-2`,
        '-frames:v', String(frames), path.join(outDir, 'f%02d.jpg')]);
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort();
      if (!files.length) return fail(`录屏抽帧失败：${res.err.slice(0, 200)}（视频在 ${local}）`);
      const content = [{ type: 'text', text: `手机录屏 ${seconds} 秒，抽了 ${files.length} 帧（视频：${local}）` }];
      for (const f of files) {
        const p = path.join(outDir, f);
        if (fs.statSync(p).size > 0) {
          content.push({ type: 'text', text: `第 ${f} 帧：` });
          content.push({ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType: 'image/jpeg' });
        }
      }
      return { content };
    } catch (e) {
      return fail(`录屏失败：${e?.message ?? e}`);
    }
  }
);

// ── 硬性限流：把"别太过分"写进代码（不靠她自觉）──────────────────────────
// 写操作（点按/打字/滑动/按键/开应用/shell）每天上限、每分钟上限；
// 截图/录屏也有上限，避免她一直盯着你的屏幕看。
const RATE_LIMIT = {
  write: { perMinute: 5, perDay: 40, hits: [] },
  look:  { perMinute: 3, perDay: 80, hits: [] },
};
function rateCheck(kind) {
  const rl = RATE_LIMIT[kind];
  const now = Date.now();
  rl.hits = rl.hits.filter((t) => now - t < 24 * 3600 * 1000);
  const lastMin = rl.hits.filter((t) => now - t < 60000).length;
  if (lastMin >= rl.perMinute) return `【限流】${kind} 类操作每分钟最多 ${rl.perMinute} 次，已拒绝。`;
  if (rl.hits.length >= rl.perDay) return `【限流】${kind} 类操作每天最多 ${rl.perDay} 次，今天已用完，请明天再来。`;
  rl.hits.push(now);
  return null;
}
const WRITE_TOOLS = new Set(['phone_tap', 'phone_tap_text', 'phone_text', 'phone_swipe', 'phone_key', 'phone_open_app', 'phone_shell']);
const LOOK_TOOLS = new Set(['phone_screenshot', 'phone_dump', 'phone_record_screen']);
server.tool = new Proxy(server.tool.bind(server), {
  apply(target, thisArg, args) {
    const name = args[0];
    const kind = WRITE_TOOLS.has(name) ? 'write' : LOOK_TOOLS.has(name) ? 'look' : null;
    if (!kind) return Reflect.apply(target, thisArg, args);
    const handler = args[args.length - 1];
    args[args.length - 1] = async (...rest) => {
      const blocked = rateCheck(kind);
      if (blocked) return fail(blocked);
      return await handler(...rest);
    };
    return Reflect.apply(target, thisArg, args);
  },
});
// ── QQ 空间（说说）：发/看/赞/评（删除与拉黑故意不提供）──────────────────────
// 只给"创作类"能力，符合她"不删任何东西"的规矩；带频率上限防刷屏。
function htmlToText(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const QZONE_LIMIT = { perMinute: 3, perDay: 20, hits: [] };

// ── 补齐 qzone_* 依赖的两个符号（原版缺失，调用即 ReferenceError）────────────────
// SnowLuma OneBot HTTP 端点：默认本地 3000，可用 SNOWLUMA_HTTP 覆盖。
const SNOWLUMA_HTTP = String(process.env.SNOWLUMA_HTTP || 'http://127.0.0.1:3000').replace(/\/+$/, '');

/**
 * 取 SnowLuma 的 OneBot accessToken。
 * 顺序：环境变量 → SNOWLUMA_CONFIG 指定的 config.json → qq-bridge 默认配置。
 * 只读本地文件，不联网。
 */
function loadSnowlumaToken() {
  // 1) 显式环境变量优先（推荐：MCP 客户端配置里直接写）
  const direct = String(process.env.SNOWLUMA_ACCESS_TOKEN || '').trim();
  if (direct) return direct;
  // 2) 其次读配置文件（SNOWLUMA_CONFIG 指定，或几个常见位置）
  const candidates = [
    process.env.SNOWLUMA_CONFIG,
    path.join(process.cwd(), 'config.json'),
    path.join(os.homedir(), '.dsh', 'qq-bridge', 'config.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const token = cfg?.snowluma?.accessToken || cfg?.accessToken;
      if (token) return String(token).trim();
    } catch {}
  }
  return '';
}

async function snowluma(action, payload) {
  const token = loadSnowlumaToken();
  if (!token) throw new Error('拿不到 SnowLuma 访问令牌（config.json 的 snowluma.accessToken）');
  const res = await fetch(SNOWLUMA_HTTP + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload ?? {}),
  });
  const txt = await res.text();
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch {}
  if (!res.ok || !data || data.status !== 'ok') {
    throw new Error(`SnowLuma ${action} 失败：HTTP ${res.status} ${txt.slice(0, 260)}`);
  }
  return data.data;
}

function qzoneRateCheck() {
  const now = Date.now();
  QZONE_LIMIT.hits = QZONE_LIMIT.hits.filter((t) => now - t < 24 * 3600 * 1000);
  if (QZONE_LIMIT.hits.filter((t) => now - t < 60000).length >= QZONE_LIMIT.perMinute) {
    return `【限流】空间操作每分钟最多 ${QZONE_LIMIT.perMinute} 次，稍后再来`;
  }
  if (QZONE_LIMIT.hits.length >= QZONE_LIMIT.perDay) {
    return `【限流】空间操作每天最多 ${QZONE_LIMIT.perDay} 次，今天用完了`;
  }
  QZONE_LIMIT.hits.push(now);
  return null;
}

// 评论单独限流：撤不回，所以更严（每 10 分钟 1 条、每天 3 条）
const COMMENT_LIMIT = { perTenMin: 2, perDay: 10, hits: [] };
function commentRateCheck() {
  const now = Date.now();
  COMMENT_LIMIT.hits = COMMENT_LIMIT.hits.filter((t) => now - t < 24 * 3600 * 1000);
  if (COMMENT_LIMIT.hits.filter((t) => now - t < 10 * 60 * 1000).length >= COMMENT_LIMIT.perTenMin) {
    return `评论每 10 分钟最多 ${COMMENT_LIMIT.perTenMin} 条（发出撤不回），稍后再来`;
  }
  if (COMMENT_LIMIT.hits.length >= COMMENT_LIMIT.perDay) {
    return `评论每天最多 ${COMMENT_LIMIT.perDay} 条，今天用完了，明天再来`;
  }
  COMMENT_LIMIT.hits.push(now);
  return null;
}

server.tool(
  'qzone_post',
  '发一条 QQ 空间说说（你自己的空间）。可以纯文字，也可以带图（图片只能来自截图目录/媒体目录，或 http(s) 链接）。带频率上限：每分钟 1 条、每天 8 条。',
  {
    content: z.string().describe('说说正文'),
    images: z.array(z.string()).optional().describe('配图：截图目录/媒体目录里的文件名或路径，或 http(s) 图片链接；最多 9 张'),
  },
  async ({ content, images }) => {
    try {
      const blocked = qzoneRateCheck();
      if (blocked) return fail(blocked);
      const files = [];
      for (const img of images ?? []) {
        const r = resolveImage(img);
        if (r.error) return fail(String(r.error).replace('图片', '配图'));
        files.push(r.file);
      }
      const data = await snowluma('send_qzone_msg', files.length ? { content, images: files } : { content });
      return text(`已发说说 ✓\n${JSON.stringify(data ?? {}, null, 2).slice(0, 400)}`);
    } catch (e) {
      return fail(`发说说失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_my_posts',
  '看你自己的 QQ 空间说说列表（用来确认发出去没有、或者回顾自己发过什么）。想看别人的（含主人的）用 qzone_feeds。',
  { num: z.number().int().min(1).max(20).default(5).describe('看几条，默认 5') },
  async ({ num }) => {
    try {
      const data = await snowluma('get_qzone_msg_list', { num });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到说说列表：${JSON.stringify(data ?? {}).slice(0, 300)}`);
      }
      const lines = list.slice(0, num).map((x, i) => {
        const t = x.content || x.summary || x.text || '';
        return `${i + 1}. [tid=${x.tid ?? x.id ?? '?'}] ${String(t).slice(0, 70)}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`你自己的说说（${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(`看说说失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_like',
  '给一条 QQ 空间说说点赞。tid 从 qzone_feeds（好友动态）或 qzone_my_posts 里拿 —— **不需要用户给链接**（QQ 卡片里的链接抠不出来是正常的，用 qzone_feeds 绕过）。',
  {
    tid: z.string().describe('说说的 tid'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（数字，会自动转；给自己的说说可不填）'),
    abstime: z.number().optional().describe('时间戳（部分接口需要）'),
  },
  async ({ tid, targetUin, abstime }) => {
    try {
      const blocked = qzoneRateCheck();
      if (blocked) return fail(blocked);
      const payload = { tid };
      if (targetUin) payload.target_uin = Number(targetUin);
      if (abstime) payload.abstime = abstime;
      const data = await snowluma('like_qzone', payload);
      return text(`点赞成功 ✓ ${JSON.stringify(data ?? {}).slice(0, 200)}`);
    } catch (e) {
      return fail(`点赞失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_comment',
  '评论一条 QQ 空间说说（有严格限额：每 10 分钟 1 条、每天 3 条，因为发出撤不回）。tid 从 qzone_feeds 里拿 —— 不用问用户要链接。想表达喜欢优先点赞。',
  {
    tid: z.string().describe('说说的 tid'),
    content: z.string().describe('评论内容'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（数字）'),
  },
  async ({ tid, content, targetUin }) => {
    // 评论是开着的，但单独限流：发出去撤不回（QQ 空间没有删评论接口），所以宁可少发。
    try {
      const blocked = commentRateCheck();
      if (blocked) return fail(blocked);
      const payload = { tid, content };
      if (targetUin) payload.target_uin = Number(targetUin);
      const data = await snowluma('comment_qzone', payload);
      return text(`评论成功 ✓ ${JSON.stringify(data ?? {}).slice(0, 200)}`);
    } catch (e) {
      return fail(`评论失败：${e?.message ?? e}`);
    }
  }
);

// 看别人空间单独限流：SnowLuma 的查询通道有频率上限，一口气翻一群人会被限流（日志里会刷 WARN）。
const VISIT_LIMIT = { perThreeMin: 5, perDay: 40, hits: [] };
function visitRateCheck() {
  const now = Date.now();
  VISIT_LIMIT.hits = VISIT_LIMIT.hits.filter((t) => now - t < 24 * 3600 * 1000);
  if (VISIT_LIMIT.hits.filter((t) => now - t < 3 * 60 * 1000).length >= VISIT_LIMIT.perThreeMin) {
    return `【限流】看别人空间 3 分钟最多 ${VISIT_LIMIT.perThreeMin} 个人（翻太快会被 QQ 限流），歇一会儿再看`;
  }
  if (VISIT_LIMIT.hits.length >= VISIT_LIMIT.perDay) {
    return `【限流】看别人空间今天到上限了（${VISIT_LIMIT.perDay} 次），明天再逛`;
  }
  VISIT_LIMIT.hits.push(now);
  return null;
}

server.tool(
  'qzone_user_posts',
  '看【指定的人】的 QQ 空间说说（群友也行）：传他的 QQ 号就行 —— 不用链接。拿到 tid 后可以点赞/评论。对方没开空间或设了权限时会返回失败，这是正常的。',
  {
    targetUin: z.union([z.string(), z.number()]).describe('要看的人的 QQ 号（数字，群友的号可以从 qq_get_group_members 拿）'),
    num: z.number().int().min(1).max(20).default(5).describe('看几条，默认 5'),
  },
  async ({ targetUin, num }) => {
    try {
      const blocked = visitRateCheck();
      if (blocked) return fail(blocked);
      const data = await snowluma('get_qzone_msg_list', { target_uin: Number(targetUin), num });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到说说（对方可能没开空间 / 设了权限 / 最近没发）：${JSON.stringify(data ?? {}).slice(0, 200)}`);
      }
      const lines = list.slice(0, num).map((x, i) => {
        const txt = htmlToText(x.content ?? x.summary ?? x.html ?? '').slice(0, 70);
        return `${i + 1}. [tid=${x.tid ?? x.key ?? '?'}] ${txt || '(无文字，可能是图片说说)'}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`QQ ${targetUin} 的说说（${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('-10031') || msg.includes('保密') || msg.includes('没有权限')) {
        return fail(`对方的空间设了权限（QQ 提示「主人设置了保密」），看不了 —— 这是正常的，换个目标，别提这事、别反复试同一个`);
      }
      if (msg.includes('rate-limited') || msg.includes('限流')) {
        return fail(`查得太快了被 QQ 限流了，歇几分钟再看（别一口气翻一群人）`);
      }
      return fail(`看对方空间失败：${msg.slice(0, 160)}`);
    }
  }
);

server.tool(
  'qzone_feeds',
  '看 QQ 空间【好友动态】（包括主人发的说说）。**想给某条说说点赞/评论时先调这个**，返回里带 tid，再用 qzone_like / qzone_comment。不需要用户提供链接。',
  {
    count: z.number().int().min(1).max(20).default(8).describe('看几条，默认 8'),
    page: z.number().int().min(1).max(5).default(1).describe('第几页，默认 1'),
  },
  async ({ count, page }) => {
    try {
      const data = await snowluma('get_qzone_feeds', { page_num: page, count });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? data?.feeds ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到好友动态：${JSON.stringify(data ?? {}).slice(0, 300)}`);
      }
      const lines = list.slice(0, count).map((x, i) => {
        const who = x.nickname || x.name || x.uin || x.user_id || '?';
        const txt = htmlToText(x.html ?? x.content ?? x.summary ?? x.text ?? '').slice(0, 60);
        const pics = (x.pic || x.images || []).length;
        return `${i + 1}. [tid=${x.key ?? x.tid ?? x.id ?? '?'}] [uin=${x.uin ?? x.user_id ?? '?'}] ${who}: ${txt}${pics ? ` (${pics}图)` : ''}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`好友动态（第 ${page} 页，${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(`看好友动态失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_recent_like',
  '给好友动态里最新的一条直接点赞。**只要知道昵称就行**（比如 who="主人"），不用链接、不用 tid。可选 comment 顺便评论一句。',
  {
    who: z.string().optional().describe('只找这个人的动态（昵称或 QQ 号的一部分，例如 主人）'),
    comment: z.string().optional().describe('顺便评论一句（可选）'),
  },
  async ({ who, comment }) => {
    try {
      const blocked = qzoneRateCheck();
      if (blocked) return fail(blocked);
      const data = await snowluma('get_qzone_feeds', { page_num: 1, count: 20 });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? data?.feeds ?? []);
      if (!Array.isArray(list) || !list.length) return fail('没取到好友动态，点赞失败');
      let hit = list[0];
      if (who) {
        const found = list.find((x) => JSON.stringify(x).includes(who));
        if (!found) return fail(`最近 20 条动态里没找到「${who}」发的`);
        hit = found;
      }
      const tid = hit.key ?? hit.tid ?? hit.id;
      const uin = hit.uin ?? hit.user_id;
      const who2 = hit.nickname || hit.name || uin;
      const payload = { tid };
      if (uin) payload.target_uin = Number(uin);
      const at = Number(hit.abstime ?? hit.time ?? 0);
      if (at) payload.abstime = at;
      await snowluma('like_qzone', payload);
      let extra = '';
      if (comment) {
        const cblocked = commentRateCheck();
        if (cblocked) {
          extra = `（今天评论次数用完了，只点了赞：${cblocked}）`;
        } else {
          const cp = { tid, content: comment };
          if (uin) cp.target_uin = Number(uin);
          await snowluma('comment_qzone', cp);
          extra = `，并评论了「${comment}」`;
        }
      }
      const txt = htmlToText(hit.html ?? hit.content ?? hit.summary ?? '').slice(0, 50);
      return text(`已给 ${who2} 的动态点赞${extra} ✓\n那条是：${txt}`);
    } catch (e) {
      return fail(`点赞失败：${e?.message ?? e}`);
    }
  }
);

if (process.argv.includes('--selftest')) {
  const v = await adb(['version'], { serial: false });
  console.log('adb:', v.ok ? v.out.split(/\r?\n/)[0] : v.err);
  const d = await adb(['devices', '-l'], { serial: false });
  console.log('devices:\n' + d.out);
  console.log('shot dir:', SHOT_DIR, fs.existsSync(SHOT_DIR) ? '(存在)' : '(将创建)');
  console.log('host:', os.hostname());
} else {
  await server.connect(new StdioServerTransport());
}
