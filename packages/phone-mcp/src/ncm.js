// 网易云音乐 PC 版控制模块
// 原理：客户端带 --remote-debugging-port=9222 启动后，用 CDP 注入 webpackJsonp 偷出 require，
//       然后读写它的内部 redux store（playing / async:listenTogether）。
// 参考：github.com/zbqbbm/netease-listen-together-mcp（macOS + 3.1.8，本机是 Windows + 3.1.41，
//       核心模块号从 11 变成 8，其它 action 名通用）。
//
// 实测环境：网易云 3.1.41.205529 / Windows / Node 24（有全局 WebSocket）

const CDP_PORT = 9222;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const NCM_HEADERS = { 'User-Agent': UA, Referer: 'https://music.163.com/' };

// ── CDP ──────────────────────────────────────────────────────────────────────

async function cdpTargetUrl() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(6000) });
  const list = await r.json();
  const page = list.find((x) => x.type === 'page') || list[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error('找不到网易云的调试页面（客户端没带 CDP 参数启动？）');
  return page.webSocketDebuggerUrl;
}

function cdpEvalOnce(wsUrl, expression, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('CDP 执行超时'));
    }, timeoutMs);
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(arg);
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true },
      }));
    };
    ws.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      if (d.id !== 1) return;
      const res = d.result || {};
      if (res.exceptionDetails) {
        const desc = (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text;
        finish(reject, new Error(String(desc).slice(0, 300)));
      } else {
        finish(resolve, res.result ? res.result.value : null);
      }
    };
    ws.onerror = () => finish(reject, new Error('CDP 连接失败（客户端在跑吗？调试端口开着吗？）'));
  });
}

const BOOT_EXPR = `(function () {
  if (!window.__ww) {
    try {
      webpackJsonp.push([[-991337], { 991337: function (m, e, require) { window.__ww = require; } }, [[991337]]]);
    } catch (err) { return 'PUSH_FAIL:' + err.message; }
  }
  if (!window.__ww) return 'NO_REQUIRE';
  var ids = Object.keys(window.__ww.c || {});
  return 'OK:' + ids.length;
})()`;

// 找到暴露 getDispatch/getStore 的模块号（版本无关：扫模块缓存，不写死）
const FIND_CORE_EXPR = `(function () {
  var req = window.__ww;
  if (!req) return '';
  if (window.__ncmCore) return window.__ncmCore;
  var ids = Object.keys(req.c || {});
  for (var i = 0; i < ids.length; i++) {
    var ex = req.c[ids[i]] && req.c[ids[i]].exports;
    if (!ex) continue;
    var ks = Object.keys(ex);
    for (var j = 0; j < ks.length; j++) {
      var v = ex[ks[j]];
      if (v && typeof v === 'object' && typeof v.getDispatch === 'function' && typeof v.getStore === 'function') {
        window.__ncmCore = ids[i] + '.' + ks[j];
        return window.__ncmCore;
      }
    }
  }
  return '';
})()`;

let coreCache = null;

/** 确保注入完成并拿到核心模块，返回 '8.a' 这样的字符串 */
export async function ensureCore() {
  const ws = await cdpTargetUrl();
  const boot = await cdpEvalOnce(ws, BOOT_EXPR);
  if (typeof boot !== 'string' || boot.indexOf('OK') !== 0) throw new Error('注入 webpack 失败：' + boot);
  if (coreCache) return coreCache;
  const found = await cdpEvalOnce(ws, FIND_CORE_EXPR);
  if (!found) throw new Error('没找到客户端核心模块（版本可能又变了）');
  coreCache = found;
  return coreCache;
}

/** 在客户端里执行一段 JS（自动带上 req / core，可用 await） */
export async function clientEval(bodyExpr) {
  const core = await ensureCore();
  const ws = await cdpTargetUrl();
  const expr = `(async function () {
    var req = window.__ww;
    var core = req(${JSON.stringify(core.split('.')[0])})[${JSON.stringify(core.split('.')[1])}];
    return await (async function (req, core) { ${bodyExpr} })(req, core);
  })()`;
  return cdpEvalOnce(ws, expr, 40000);
}

/** 派发一个 redux action */
export async function dispatch(action) {
  const core = await ensureCore();
  const ws = await cdpTargetUrl();
  const expr = `(function () {
    var req = window.__ww;
    var core = req(${JSON.stringify(core.split('.')[0])})[${JSON.stringify(core.split('.')[1])}];
    return Promise.resolve(core.getDispatch()(${JSON.stringify(action)})).then(function () { return true; });
  })()`;
  return cdpEvalOnce(ws, expr);
}

// ── 读状态 ───────────────────────────────────────────────────────────────────

/** 当前在听什么（真·耳朵）：歌名/歌手/进度/是否在放/当前那句歌词 */
export async function nowPlaying() {
  const out = await clientEval(`
    var p = core.getStore().playing || {};
    var cur = p.curPlaying || {};
    var tr = cur.track || p.curTrack || {};
    var artists = (tr.artists || p.resourceArtists || []).map(function (a) { return a.name; }).join('/');
    return {
      songId: String(cur.resourceId || tr.id || p.resourceTrackId || ''),
      title: tr.name || p.resourceName || '',
      artist: artists,
      album: (tr.album || {}).name || '',
      duration: Number(tr.duration || p.resourceDuration || 0) / 1000,
      playing: p.playingState === 2,
      lyricLine: Number(p.playingLyricLineNumber || 0),
      lyric: String(p.playingLyric || ''),
      playMode: String(p.playingMode || '')
    };
  `);
  if (!out || !out.title) return { ok: false, error: '客户端现在没在放歌（或者读不到）', raw: out };
  return Object.assign({ ok: true }, out);
}

/** 一起听房间状态 */
export async function roomState() {
  const out = await clientEval(`
    var s = core.getStore();
    var lt = s['async:listenTogether'] || {};
    var ri = lt.roomInfo || {};
    var members = (lt.roomMembers || []).map(function (m) {
      return { id: m.userId || m.id || '', name: m.nickname || m.name || '' };
    });
    var other = lt.otherMember || {};
    var list = s['async:listenTogetherPlayList'] || {};
    return {
      status: String(lt.status || ''),
      roomId: String(ri.roomId || ''),
      chatRoomId: String(ri.chatRoomId || ''),
      creatorId: Number(ri.creatorId || 0),
      members: members,
      other: { id: other.userId || other.id || '', name: other.nickname || other.name || '' },
      listenCount: Number(lt.listenCount || 0),
      totalSec: Number(lt.totalConnectionTime || 0),
      songCount: (list.playList || list.songs || []).length
    };
  `);
  return Object.assign({ ok: !!(out && out.roomId) }, out || {});
}

// ── 控制 ─────────────────────────────────────────────────────────────────────

const LOCAL = { play: 'playing/resume', pause: 'playing/pause' };

/** 本地播放控制：play / pause / next / previous */
export async function control(command) {
  if (command === 'next' || command === 'previous') {
    return dispatch({
      type: 'playingList/jump2Track',
      payload: { flag: command === 'previous' ? -1 : 1, type: 'call', triggerScene: 'minibarController' },
    }).then(() => ({ ok: true, command }));
  }
  if (LOCAL[command]) return dispatch({ type: LOCAL[command], payload: {} }).then(() => ({ ok: true, command }));
  throw new Error('不支持的本地命令：' + command + '（可用 play/pause/next/previous）');
}

/** 房间控制：PLAY / PAUSE / NEXT / PREVIOUS / GOTO / PROGRESS（需先在房间里） */
export async function roomControl(command, { ids = null, position = null, playStatus = null } = {}) {
  const cmd = String(command || '').toUpperCase();
  if (!['PLAY', 'PAUSE', 'NEXT', 'PREVIOUS', 'GOTO', 'PROGRESS'].includes(cmd)) {
    throw new Error('不支持的房间命令：' + command);
  }
  const room = await roomState();
  if (!room.roomId) throw new Error('现在不在一起听房间里');
  if (['NEXT', 'PREVIOUS', 'GOTO'].includes(cmd) && (!Array.isArray(ids) || ids.length !== 2)) {
    throw new Error(cmd + ' 需要 ids = [前一首, 目标曲]');
  }
  const payload = { command: cmd, reason: 'force' };
  if (ids) payload.ids = ids.map(String);
  if (position != null) payload.position = position;
  if (playStatus != null) payload.playStatus = playStatus;
  if (cmd === 'PLAY') payload.playStatus = payload.playStatus == null ? 2 : payload.playStatus;
  if (cmd === 'PAUSE') payload.playStatus = payload.playStatus == null ? 1 : payload.playStatus;
  await dispatch({ type: 'async:listenTogetherPlayStatus/reportRequest', payload });
  return { ok: true, command: cmd };
}

// ── HTTP（搜索 / 歌词 / 评论） ────────────────────────────────────────────────

async function ncmGet(url) {
  const r = await fetch(url, { headers: NCM_HEADERS, signal: AbortSignal.timeout(15000) });
  return r.json();
}

/** 搜歌，返回 [{id,name,artist,album}] */
export async function search(keyword, limit = 8) {
  const j = await ncmGet(`https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}`);
  const songs = (j && j.result && j.result.songs) || [];
  return songs.map((s) => ({
    id: s.id,
    name: s.name,
    artist: (s.artists || []).map((a) => a.name).join('/'),
    album: (s.album || {}).name || '',
    duration: Math.round((s.duration || 0) / 1000),
  }));
}

/** 歌词（带时间轴） */
export async function lyric(songId) {
  const j = await ncmGet(`https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`);
  const lrc = (j && j.lrc && j.lrc.lyric) || '';
  const lines = [];
  for (const line of lrc.split(/\r?\n/)) {
    const m = /^\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/.exec(line.trim());
    if (m && m[3]) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3] });
  }
  return lines;
}

/** 纯文本歌词（给聊天用，去掉时间轴） */
export async function lyricText(songId, maxLines = 40) {
  const lines = await lyric(songId);
  return lines
    .filter((l) => !/^作词|^作曲|^编曲|^制作人|^出品|^混音|^母带|^录音|^监制|^统筹|^企划|^OP|^SP|^发行/.test(l.text))
    .slice(0, maxLines)
    .map((l) => l.text);
}

/** 读某首歌的评论 */
export async function comments(songId, limit = 20, offset = 0) {
  const j = await ncmGet(`https://music.163.com/api/v1/resource/comments/R_SO_4_${songId}?limit=${limit}&offset=${offset}`);
  const hot = (j && j.hotComments) || [];
  const list = (j && j.comments) || [];
  const fmt = (c) => ({ user: (c.user || {}).nickname || '', text: c.content || '', likes: c.likedCount || 0, time: c.time });
  return { total: (j && j.total) || 0, hot: hot.map(fmt), latest: list.map(fmt) };
}

/** 发一条评论（就是"在歌里互动"）—— 需要 Cookie，见 postCommentWithCookie */
export async function postComment(songId, content, cookie) {
  if (!cookie) throw new Error('发评论需要网易云 Cookie（MUSIC_U + __csrf）');
  const csrf = (/__csrf=([^;]+)/.exec(cookie) || [])[1] || '';
  const body = new URLSearchParams({
    content: String(content),
    resourceId: String(songId),
    resourceType: '4',
    csrf_token: csrf,
  });
  const r = await fetch(`https://music.163.com/api/resource/comments/R_SO_4_${songId}?csrf_token=${encodeURIComponent(csrf)}`, {
    method: 'POST',
    headers: Object.assign({}, NCM_HEADERS, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
      Referer: `https://music.163.com/song?id=${songId}`,
    }),
    body,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  return { ok: !!(j && (j.code === 200 || j.comment)), raw: j };
}

/** 点歌播放（本地）。参考项目用内部模块 102 把 songId 变成 track 对象；
 *  模块号可能随版本变化，所以先试 102，再试几个候选，最后扫一遍。 */
export async function playSong(songId, title = '') {
  const core = await ensureCore();
  const ws = await cdpTargetUrl();
  const expr = `(async function () {
    var req = window.__ww;
    var core = req(${JSON.stringify(core.split('.')[0])})[${JSON.stringify(core.split('.')[1])}];
    var id = ${JSON.stringify(String(songId))};
    // ① 找歌曲加载器：优先 102，其次扫出"导出是单参函数"的模块里能返回 track 的
    var candidates = [102];
    var loader = null;
    for (var i = 0; i < candidates.length; i++) {
      try {
        var m = req(candidates[i]);
        if (m && typeof m.a === 'function') {
          var t = await m.a([{ id: id, v: 0 }]);
          if (t && (Array.isArray(t) ? t.length : true)) { loader = m.a; break; }
        }
      } catch (e) {}
    }
    if (!loader) return { ok: false, error: '找不到歌曲加载器（模块号可能变了，需要重新扫）' };
    var tracks = await loader([{ id: id, v: 0 }]);
    // ② 在房间里的话，先关掉房间上报，免得房间把这条播放顶掉
    var st = core.getStore();
    var lt = st['async:listenTogether'] || {};
    var ri = lt.roomInfo || {};
    var d = core.getDispatch();
    var inRoom = !!(ri.roomId && lt.status && lt.status !== 'alone');
    if (inRoom) {
      try { d({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: false } }); } catch (e) {}
    }
    await Promise.resolve(d({
      type: 'playing/play',
      payload: {
        tracks: tracks,
        from: { scene: 'search', resourceType: 'track', fromInfo: {}, text: ${JSON.stringify(String(title || ''))}, href: '/song/' + id },
        options: { clear: false, play: true, playId: id, fromDoubleClick: true }
      }
    }));
    if (inRoom) {
      setTimeout(function () {
        try { d({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: true } }); } catch (e) {}
      }, 5000);
    }
    return { ok: true };
  })()`;
  return cdpEvalOnce(ws, expr, 30000);
}

/** 汇总：一句话说清"现在在听什么 + 唱到哪一句" */
export async function earsReport() {
  const p = await nowPlaying();
  if (!p.ok) return p;
  let line = '';
  let nearby = [];
  try {
    if (p.songId) {
      const lines = await lyric(p.songId);
      if (lines.length) {
        // 客户端已经告诉我们唱到第几行了（playingLyricLineNumber，1 起），拿它对齐
        const idx = Math.max(0, Math.min(lines.length - 1, (p.lyricLine || 1) - 1));
        if (lines[idx] && (!p.lyric || lines[idx].text !== p.lyric)) {
          // 行号对不上就用文本找
          const k = lines.findIndex((l) => l.text === p.lyric);
          if (k >= 0) line = lines[k].text;
          else line = lines[idx].text;
        } else {
          line = p.lyric || (lines[idx] ? lines[idx].text : '');
        }
        nearby = lines.slice(Math.max(0, idx - 2), idx + 3).map((l, i) => ({
          text: l.text,
          current: l.text === line,
        }));
      }
    }
  } catch {}
  return Object.assign({}, p, { currentLine: line, nearby });
}

// ── 网易云私信（借客户端的手，不需要 Cookie） ────────────────────────────────

/** 读私信会话列表 */
export async function msgUsers(limit = 20) {
  const out = await clientEval(`
    try {
      var r = await fetch('https://music.163.com/api/msg/private/users?offset=0&limit=${limit}', { credentials: 'include' });
      var j = await r.json();
      return { ok: j.code === 200, code: j.code, list: (j.msgs || []).map(function (m) {
        var u = m.fromUser || m.user || {};
        return { userId: String(u.userId || ''), nick: u.nickname || '', last: String(m.lastMsg || m.text || '').slice(0, 60), time: m.time || 0 };
      }) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  `);
  return out;
}

/** 读跟某个人的私信历史 */
export async function inbox(userId, limit = 20) {
  const out = await clientEval(`
    try {
      var r = await fetch('https://music.163.com/api/msg/private/history?userId=${userId}&offset=0&limit=${limit}&total=false', { credentials: 'include' });
      var j = await r.json();
      var me = String((core.getStore().host || {}).uid || '');
      return { ok: j.code === 200, code: j.code, me: me, list: (j.msgs || []).map(function (m) {
        var f = m.fromUser || {};
        return { from: String(f.userId || ''), fromNick: f.nickname || '', self: String(f.userId || '') === me, text: String(m.text || ''), time: m.time || 0 };
      }) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  `);
  return out;
}

/** 发私信（目前网易云返回"参数错误"，缺客户端内部请求封装的签名；先留着接口） */
export async function sendPrivate(userId, text, csrf) {
  const out = await clientEval(`
    try {
      var b = new URLSearchParams();
      b.set('userIds', '[${userId}]');
      b.set('text', ${JSON.stringify(String(text))});
      b.set('csrf_token', ${JSON.stringify(String(csrf || ''))});
      var r = await fetch('https://music.163.com/api/msg/private/send', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString()
      });
      var t = await r.text();
      return { ok: t.indexOf('"code":200') >= 0, raw: t.slice(0, 300) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  `);
  return out;
}
