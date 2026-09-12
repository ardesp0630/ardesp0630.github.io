// ============================================================
//  DeepSeek 显示屏 - 手机 App
//  通过蓝牙 BLE 配置设备 / 读取余额 / 调整界面
// ============================================================
const BLE_SERVICE        = 'd5f10001-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_SSID      = 'd5f10002-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_PWD       = 'd5f10003-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_KEY       = 'd5f10004-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_CMD       = 'd5f10005-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_STATUS    = 'd5f10006-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_SETTINGS  = 'd5f10007-6f2a-4b6f-9a2a-8b0e2b7f9c01';

let bleServer = null, bleService = null, bleDevice = null;
const enc = new TextEncoder();

// ---------- 工具 ----------
function toast(msg, ms) {
  const t = document.getElementById('toast');
  if (!t) { try { alert(msg) } catch (e) {} return; }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms || 2200);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const $ = id => document.getElementById(id);
function setText(id, v) { const e = $(id); if (e) e.textContent = v; }

// 安全绑定：元素不存在时不抛错，避免拖垮后续绑定
function on(id, ev, fn) {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
  else console.warn('[DS] 缺少元素 #' + id);
}

// 未连接时统一拦截
function requireConn() {
  if (!bleService) {
    toast('尚未连接设备 — 请先回「主页」点「连接设备」', 3000);
    return false;
  }
  return true;
}

// 全局错误捕获：单个功能出错不影响其它按钮
window.addEventListener('error', e => {
  console.error('[DS] 未捕获错误:', e.message);
});

// ---------- 页面切换 ----------
document.querySelectorAll('.tabbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabbtn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------- 本机配置缓存 ----------
const inSsid = $('in-ssid'), inPwd = $('in-pwd'), inKey = $('in-key');

function loadConfig() {
  const cfg = JSON.parse(localStorage.getItem('ds_cfg') || '{}');
  inSsid.value = cfg.ssid || '';
  inPwd.value  = cfg.pwd  || '';
  inKey.value  = cfg.key  || '';
  setText('cfg-ssid', cfg.ssid || '--');
  setText('cfg-key', cfg.key ? cfg.key.slice(0, 8) + '…' : '--');
}
function saveConfig() {
  const cfg = { ssid: inSsid.value.trim(), pwd: inPwd.value, key: inKey.value.trim() };
  localStorage.setItem('ds_cfg', JSON.stringify(cfg));
  setText('cfg-ssid', cfg.ssid || '--');
  setText('cfg-key', cfg.key ? cfg.key.slice(0, 8) + '…' : '--');
}
[inSsid, inPwd, inKey].forEach(el => el.addEventListener('change', saveConfig));
loadConfig();

// ---------- 连接状态 ----------
function setConn(on, text) {
  const b = $('conn-badge');
  b.textContent = text || (on ? '已连接' : '未连接');
  b.className = 'badge ' + (on ? 'on' : 'off');
  setText('dev-status', on ? '在线' : '--');
  const d = $('btn-disconnect');
  if (d) d.style.display = on ? 'block' : 'none';
}

// ---------- 蓝牙扫描 ----------
async function bleScan() {
  if (!navigator.bluetooth) {
    toast('此浏览器不支持蓝牙，请用 Chrome / Edge', 4000);
    return;
  }
  try {
    setConn(false, '扫描中…');
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE]
    });
    bleServer = await device.gatt.connect();
    bleDevice = device;

    device.addEventListener('gattserverdisconnected', () => {
      bleService = null; bleServer = null; bleDevice = null;
      setConn(false, '已断开');
      setText('dev-info', '设备已断开，请重新连接');
    });

    bleService = await bleServer.getPrimaryService(BLE_SERVICE);
    const st = await bleService.getCharacteristic(BLE_CHAR_STATUS);
    await st.readValue();                       // 触发一次读取确认可用

    const name = device.name || 'DS-Display';
    setConn(true, '已连接');
    setText('dev-info', name);
    toast('已连接 ' + name);

    await refreshBalance();
    await refreshSettingsFromDevice();
  } catch (e) {
    setConn(false, '连接失败');
    setText('dev-info', e.message || String(e));
  }
}

function bleDisconnect() {
  try { if (bleServer && bleServer.connected) bleServer.disconnect(); } catch (e) {}
  bleService = null; bleServer = null; bleDevice = null;
  setConn(false, '未连接');
  setText('dev-info', '点下方按钮连接设备');
}

async function writeChar(ch, value) {
  try {
    await ch.writeValue(enc.encode(value));
  } catch (e) {
    await ch.writeValueWithoutResponse(enc.encode(value));
  }
}

function handleGattError(e) {
  const msg = (e && e.message) ? e.message : String(e);
  if (msg.indexOf('disconnected') >= 0 || msg.indexOf('GATT') >= 0) {
    bleService = null;
    setConn(false, '已断开');
    return '设备已断开，请重新连接后再试';
  }
  return '发送失败：' + msg;
}

// ---------- 发送 WiFi / Key ----------
async function bleSend() {
  const ssid = inSsid.value.trim();
  const pwd  = inPwd.value;
  const key  = inKey.value.trim();
  if (!ssid || !key) { toast('请先填写 WiFi 名称和 API Key'); return; }
  if (!requireConn()) return;

  const btn = $('btn-ble-send');
  btn.disabled = true;
  try {
    const chSsid = await bleService.getCharacteristic(BLE_CHAR_SSID);
    const chPwd  = await bleService.getCharacteristic(BLE_CHAR_PWD);
    const chKey  = await bleService.getCharacteristic(BLE_CHAR_KEY);
    const chCmd  = await bleService.getCharacteristic(BLE_CHAR_CMD);
    await writeChar(chSsid, ssid); await sleep(250);
    await writeChar(chPwd, pwd);   await sleep(250);
    await writeChar(chKey, key);   await sleep(250);
    saveConfig();
    try { await writeChar(chCmd, 'SAVE'); } catch (e) {}
    toast('已发送，设备正在重连 WiFi（蓝牙不断）', 3500);
    // 设备热重连约需 5~20 秒，稍后刷新状态
    setTimeout(() => { if (bleService) refreshBalance(); }, 8000);
  } catch (e) {
    toast(handleGattError(e), 3500);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 界面设置 ----------
const SET_KEYS = ['showChart', 'showUsed', 'showPolls', 'showToken', 'showWifi'];
const SET_IDS  = { showChart: 'set-chart', showUsed: 'set-used', showPolls: 'set-polls',
                   showToken: 'set-tok',   showWifi: 'set-wifi' };

function readSettings() {
  const out = { bri: +$('set-bri').value, poll: +$('set-poll').value, rot: +$('set-rot').value };
  SET_KEYS.forEach(k => { out[k] = !!$(SET_IDS[k]).checked; });
  return out;
}

function loadSettings() {
  const s = JSON.parse(localStorage.getItem('ds_set2') || '{}');
  SET_KEYS.forEach(k => { const e = $(SET_IDS[k]); if (e) e.checked = (s[k] === undefined) ? true : !!s[k]; });
  if (s.bri !== undefined) { const b = Math.max(10, Math.min(100, s.bri)); $('set-bri').value = b; setText('bri-val', b); }
  if (s.poll !== undefined) $('set-poll').value = s.poll;
  if (s.rot !== undefined) $('set-rot').value = s.rot;
  drawPreview();
}

async function sendSettings() {
  if (!requireConn()) return;
  const set = readSettings();
  localStorage.setItem('ds_set2', JSON.stringify(set));
  try {
    const ch = await bleService.getCharacteristic(BLE_CHAR_SETTINGS);
    await writeChar(ch, JSON.stringify(set));
    await sleep(500);
    await refreshSettingsFromDevice();
    toast('设置已应用（设备未重启）');
  } catch (e) {
    toast(handleGattError(e), 3500);
  }
}

async function refreshSettingsFromDevice() {
  if (!bleService) return;
  try {
    const ch = await bleService.getCharacteristic(BLE_CHAR_STATUS);
    const txt = new TextDecoder().decode(await ch.readValue());
    let d = {};
    try { d = JSON.parse(txt); } catch (e) { return; }
    if (d.bri !== undefined)  { $('set-bri').value = d.bri; setText('bri-val', d.bri); }
    if (d.poll !== undefined) $('set-poll').value = d.poll;
    if (d.rot !== undefined)  $('set-rot').value = d.rot;
    SET_KEYS.forEach(k => { const e = $(SET_IDS[k]); if (e && d[k] !== undefined) e.checked = !!d[k]; });
    drawPreview();
  } catch (e) {}
}

async function resetSettings() {
  SET_KEYS.forEach(k => { $(SET_IDS[k]).checked = true; });
  $('set-bri').value = 100; setText('bri-val', '100');
  $('set-poll').value = 60;
  $('set-rot').value = 3;
  drawPreview();
  await sendSettings();
}

// ---------- 余额 ----------
let LAST_STATUS = {}   // 最近一次从设备读到的状态，供布局预览使用

async function refreshBalance() {
  if (!bleService) return;
  try {
    const ch = await bleService.getCharacteristic(BLE_CHAR_STATUS);
    const txt = new TextDecoder().decode(await ch.readValue());
    let d = {};
    try { d = JSON.parse(txt); } catch (e) { d = {}; }
    LAST_STATUS = d;

    const bal = (typeof d.bal === 'number') ? d.bal.toFixed(2) : '--';
    const avail = d.avail === 1 ? '可用' : (d.avail === 0 ? '余额不足' : '--');
    const used = (typeof d.used === 'number') ? d.used.toFixed(2) + ' 元' : '--';
    const tok  = (typeof d.tok === 'number') ? d.tok.toLocaleString() : '--';
    const poll = (typeof d.polls === 'number') ? d.polls : '--';

    setText('home-bal', bal);
    setText('home-avail', avail);
    setText('home-used', used);
    setText('home-tok', tok);
    setText('home-polls', poll);
    setText('home-time', d.time || '--');

    const ab = $('home-avail');
    if (ab) ab.style.color = d.avail === 1 ? 'var(--ok)' : (d.avail === 0 ? '#f87171' : 'var(--dim)');
  } catch (e) {
    if (e && e.message && e.message.indexOf('disconnected') >= 0) return;
    setText('home-avail', '读取失败');
  }
}
setInterval(() => { if (bleService) refreshBalance(); }, 15000);

// ============================================================
//  屏幕预览：按固件同样的布局与配色在 canvas 上绘制
//  （160x128，2 倍放大）
// ============================================================
const PAL = {
  bg: '#C9C2B0', bar: '#F5F1E6', card: '#F5F1E6', card2: '#9C9482',
  div: '#B5B2AD', acc: '#8C5A2B', ink: '#1F1B14', ink2: '#4E4638'
};

function drawPreview() {
  const cv = $('screen-preview');
  if (!cv) return;
  const g = cv.getContext('2d');
  const Z = 2;
  g.setTransform(Z, 0, 0, Z, 0, 0);
  g.imageSmoothingEnabled = false;
  const W = 160, H = 128;
  g.clearRect(0, 0, W, H);

  const rot = +$('set-rot').value;
  // 180 度翻转：整体旋转
  if (rot === 3) {
    g.translate(W, H);
    g.rotate(Math.PI);
  }

  const on = k => !!$(SET_IDS[k]).checked;

  g.fillStyle = PAL.bg; g.fillRect(0, 0, W, H);

  // 状态栏
  g.fillStyle = PAL.bar; g.fillRect(0, 0, W, 15);
  g.fillStyle = PAL.acc;
  g.font = '8px monospace'; g.textBaseline = 'top';
  g.fillText('DeepSeek', 5, 3);
  g.fillStyle = PAL.ink2;
  g.fillText('12:34:56', W - 4 - 48, 3);
  g.beginPath(); g.arc(W - 4 - 48 - 10, 7, 3, 0, 7); g.fillStyle = '#2F6B3A'; g.fill();

  // 余额卡
  g.fillStyle = PAL.card;
  roundRect(g, 2, 16, 156, 41, 5); g.fill();
  g.fillStyle = PAL.ink;
  g.font = 'bold 24px monospace';
  g.textAlign = 'center';
  g.fillText('96.50', W / 2, 18);
  g.textAlign = 'left';
  // 涨跌
  g.fillStyle = '#9E2B24'; g.font = '8px monospace';
  g.fillText('0.02', 152 - 30, 42);
  g.beginPath(); g.moveTo(152 - 39, 44); g.lineTo(152 - 34, 44); g.lineTo(152 - 36, 49); g.fill();
  // 进度条
  g.fillStyle = PAL.card2; g.fillRect(10, 50, 140, 3);
  g.fillStyle = PAL.acc;   g.fillRect(10, 50, 17, 3);
  g.beginPath(); g.arc(27, 51, 2.5, 0, 7); g.fill();

  // 折线图卡
  if (on('showChart')) {
    g.fillStyle = PAL.card2; roundRect(g, 2, 58, 156, 31, 4); g.fill();
    g.strokeStyle = PAL.div; g.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = 62 + 11.5 * i;
      g.beginPath(); g.moveTo(6, y); g.lineTo(154, y); g.stroke();
    }
    g.strokeStyle = PAL.acc; g.beginPath();
    for (let i = 0; i < 30; i++) {
      const x = 6 + i * (148 / 29);
      const y = 80 - (Math.sin(i * 0.5) * 0.5 + 0.5) * 16 - 2;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }

  // 信息卡
  const y = 90;
  g.fillStyle = PAL.card2;
  if (on('showUsed') && on('showPolls')) {
    roundRect(g, 2, y, 77, 17, 3); g.fill();
    roundRect(g, 81, y, 77, 17, 3); g.fill();
  } else {
    roundRect(g, 2, y, 156, 17, 3); g.fill();
  }
  g.fillStyle = PAL.ink; g.font = '11px sans-serif';
  if (on('showUsed'))  g.fillText('消耗 12.34', 6, y + 3);
  if (on('showPolls')) g.fillText('次数 1527', on('showUsed') ? 85 : 6, y + 3);

  // 底栏
  g.fillStyle = PAL.ink2; g.font = '8px monospace';
  if (on('showToken')) g.fillText('Token 518211416', 4, 108);
  if (on('showWifi'))  { g.font = '11px sans-serif'; g.fillText('WiFi 1213', 4, 118); }
  g.font = '8px monospace';
  g.fillText('12:34:56', W - 4 - 48, 120);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------- 按钮绑定（全部用安全绑定） ----------
on('btn-scan', 'click', bleScan);
on('btn-disconnect', 'click', bleDisconnect);
on('btn-ble-send', 'click', bleSend);
on('btn-hotspot-send', 'click', function () {
  toast('热点步骤：连 WiFi「DS-Config」(密码 12345678) → 打开 192.168.4.1', 5000);
});
on('btn-send-set', 'click', sendSettings);
on('btn-reset-set', 'click', resetSettings);

// 余额数字点击刷新
on('bal-click', 'click', function () {
  if (!bleService) { toast('尚未连接设备'); return; }
  refreshBalance();
  toast('已刷新');
});

// 设置项变化时实时重绘预览
SET_KEYS.forEach(function (k) {
  on(SET_IDS[k], 'change', drawPreview);
});
on('set-rot', 'change', drawPreview);

// 背光滑块：显示数值 + 重绘 + 预览亮度联动
on('set-bri', 'input', function () {
  const v = $('set-bri').value;
  setText('bri-val', v);
  const cv = $('screen-preview');
  if (cv) cv.style.filter = 'brightness(' + (0.35 + v / 100 * 0.65) + ')';
  drawPreview();
});

// ============================================================
//  布局页：手机端直接拖拽调界面
//  与固件元素模型完全一致（t/x/y/w/h/c/sz/r/bind/icon/on/text）
// ============================================================
const LT = { TEXT:0, RECT:1, ROUND:2, CIRCLE:3, TRI:4, LINE:5, ICON:6, BITMAP:7, PROGRESS:8, HBAR:9 }
const LTNAME = ['文本','矩形','圆角','圆','三角','线','图标','位图','进度','柱状']
const LD = { NONE:0, BALANCE:1, DELTA:2, USED:3, TOKENS:4, POLLS:5, SSID:6, TIME:7, AVAIL:8, PCT:9,
             TOKEN_M:10, WIFI_FULL:11, PWD:12, GRANTED:13, TOPUP:14, CURRENCY:15, IP:16, RSSI:17 }
const LDNAME = ['静态文本','余额','涨跌','消耗','Token原始','次数','WiFi名','时间','可用态','额度%',
                'Token简写','WiFi整行','WiFi密码','赠送余额','充值余额','币种','本机IP','信号强度']
const LI = { NONE:0, DOT:1, UP:2, DOWN:3, CHECK:4, CROSS:5, WARN:6, RING:7, WIFI:8, CLOCK:9, BATTERY:10, BOLT:11, STAR:12, WHALE:13 }
const LICONS = [['圆点',1],['上三角',2],['下三角',3],['对勾',4],['叉号',5],['警告',6],
                ['圆环',7],['WiFi',8],['时钟',9],['电池',10],['闪电',11],['星形',12],['鲸鱼',13]]

// 主题色（与固件一致）
const PALS = {
  报纸: { bg:'#C9C2B0', bar:'#F5F1E6', card:'#F5F1E6', card2:'#9C9482', div:'#B5B2AD', acc:'#8C5A2B', ink:'#1F1B14', ink2:'#4E4638', ok:'#2F6B3A', bad:'#9E2B24' },
  深海蓝: { bg:'#08131E', bar:'#0E2336', card:'#2A6A96', card2:'#123047', div:'#1C4059', acc:'#2FB6E8', ink:'#EAF6FF', ink2:'#7FA3BC', ok:'#4BD68C', bad:'#FF7A7A' },
}
let LAY = { theme:'报纸', sel:null, els:[], nextId:1 }
const LZ = 3   // 画布放大倍数（160*3=480, 128*3=384）

function lp(k) { return PALS[LAY.theme][k] || '#000' }
function resolveC(c) { if (!c) return lp('ink'); if (c.charAt(0) === '#') return c; return lp(c) }

// 默认布局（与固件 buildDefaultLayout 一致）
function defaultLayout() {
  let id = 1
  const E = (o) => { const e = Object.assign({ id:id++, on:true, sz:1, bind:0, icon:0, text:'', r:0 }, o); LAY.els.push(e); return e }
  LAY.els = []

  E({ t:LT.RECT,  x:0,  y:0,   w:160, h:15, c:'bar' })
  E({ t:LT.TEXT,  x:5,  y:3,   w:56,  h:10, c:'acc',  text:'DeepSeek' })
  E({ t:LT.ICON,  x:118,y:4,   w:7,   h:7,  c:'ok',   icon:LI.DOT })
  E({ t:LT.TEXT,  x:128,y:3,   w:32,  h:10, c:'ink2', bind:LD.TIME })
  E({ t:LT.ROUND, x:2,  y:16,  w:156, h:32, c:'card', r:5 })
  E({ t:LT.TEXT,  x:24, y:19,  w:112, h:26, c:'ink',  sz:3, bind:LD.BALANCE })
  E({ t:LT.PROGRESS, x:10, y:44, w:140, h:4, c:'acc' })
  E({ t:LT.HBAR,  x:2,  y:52,  w:156, h:30, c:'acc' })
  E({ t:LT.ROUND, x:2,  y:86,  w:77,  h:15, c:'card2', r:3 })
  E({ t:LT.TEXT,  x:6,  y:87,  w:22,  h:13, c:'ink',  text:'消耗' })
  E({ t:LT.TEXT,  x:30, y:87,  w:44,  h:13, c:'ink',  bind:LD.USED })
  E({ t:LT.ROUND, x:81, y:86,  w:77,  h:15, c:'card2', r:3 })
  E({ t:LT.TEXT,  x:85, y:87,  w:22,  h:13, c:'ink',  text:'次数' })
  E({ t:LT.TEXT,  x:109,y:87,  w:44,  h:13, c:'ink',  bind:LD.POLLS })
  E({ t:LT.TEXT,  x:4,  y:104, w:34,  h:10, c:'ink2', text:'Token' })
  E({ t:LT.TEXT,  x:40, y:104, w:110, h:10, c:'ink2', bind:LD.TOKEN_M })
  E({ t:LT.TEXT,  x:4,  y:114, w:22,  h:10, c:'ink2', text:'WiFi' })
  E({ t:LT.TEXT,  x:28, y:114, w:80,  h:10, c:'ink2', bind:LD.SSID })
  E({ t:LT.TEXT,  x:112,y:114, w:46,  h:10, c:'ink2', bind:LD.RSSI })
  E({ t:LT.TEXT,  x:4,  y:124, w:22,  h:10, c:'bad',  text:'密码' })
  E({ t:LT.TEXT,  x:28, y:124, w:100, h:10, c:'bad',  bind:LD.PWD })
  LAY.nextId = id
}

function demoVal(bind) {
  const s = LAST_STATUS || {}
  switch (bind) {
    case LD.BALANCE: return (typeof s.bal === 'number') ? s.bal.toFixed(2) : '96.50'
    case LD.DELTA: return '-0.02'
    case LD.USED: return (typeof s.used === 'number') ? s.used.toFixed(2) : '12.34'
    case LD.TOKENS: return String(s.tok || 518211416)
    case LD.POLLS: return String(s.polls || 1527)
    case LD.SSID: return (cfgSsid() || '1213')
    case LD.TIME: return s.time || '12:34:56'
    case LD.AVAIL: return (s.avail === 0) ? '不足' : '可用'
    case LD.PCT: return (s.pct || 12) + '%'
    case LD.TOKEN_M: return fmtTok(s.tok || 518211416)
    case LD.WIFI_FULL: return 'WiFi ' + (cfgSsid() || '1213')
    case LD.PWD: return '6666666666'
    case LD.GRANTED: return '10.00'
    case LD.TOPUP: return '86.50'
    case LD.CURRENCY: return 'CNY'
    case LD.IP: return '192.168.1.23'
    case LD.RSSI: return '-58 dBm'
    default: return ''
  }
}
function cfgSsid() { try { return (JSON.parse(localStorage.getItem('ds_cfg') || '{}').ssid) || '' } catch (e) { return '' } }
function fmtTok(t) {
  if (t >= 100000000) return Math.floor(t / 100000000) + '亿' + String(Math.floor((t % 100000000) / 10000)).padStart(4, '0')
  if (t >= 10000) return (t / 10000).toFixed(2) + '万'
  return String(t)
}

// ---------- 绘制 ----------
function layRect(g, x, y, w, h, c) { if (w > 0 && h > 0) { g.fillStyle = c; g.fillRect(x, y, w, h) } }
function layRound(g, x, y, w, h, r, c) {
  if (w <= 0 || h <= 0) return
  r = Math.min(r || 0, w / 2, h / 2)
  g.fillStyle = c; g.beginPath(); g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill()
}
function layCircle(g, cx, cy, r, c) { g.fillStyle = c; g.beginPath(); g.arc(cx, cy, Math.max(0, r), 0, 7); g.fill() }
function layIcon(g, icon, x, y, w, h, c, bg) {
  const cx = x + w / 2, cy = y + h / 2, r = Math.max(1, Math.floor(Math.min(w, h) / 2))
  const p = {
    rect: (a,b,cc,d,col)=>{g.fillStyle=col;g.fillRect(a,b,cc,d)},
    circ: (a,b,rr,col)=>layCircle(g,a,b,rr,col),
    tri: (a,b,cc,d,e,f,col)=>{g.fillStyle=col;g.beginPath();g.moveTo(a,b);g.lineTo(cc,d);g.lineTo(e,f);g.closePath();g.fill()},
    ln: (a,b,cc,d,col)=>{g.strokeStyle=col;g.lineWidth=1;g.beginPath();g.moveTo(a,b);g.lineTo(cc,d);g.stroke()}
  }
  if (icon === LI.DOT) p.circ(cx, cy, r, c)
  else if (icon === LI.UP) p.tri(cx, y, x+w-1, y+h-1, x, y+h-1, c)
  else if (icon === LI.DOWN) p.tri(cx, y+h-1, x, y, x+w-1, y, c)
  else if (icon === LI.CHECK) { p.ln(x,cy,x+w/3,y+h-1,c); p.ln(x+w/3,y+h-1,x+w-1,y,c) }
  else if (icon === LI.CROSS) { p.ln(x,y,x+w,y+h,c); p.ln(x+w,y,x,y+h,c) }
  else if (icon === LI.WARN) { p.tri(cx,y,x+w-1,y+h-1,x,y+h-1,c) }
  else if (icon === LI.RING) { g.strokeStyle=c; g.beginPath(); g.arc(cx,cy,r-1,0,7); g.stroke() }
  else if (icon === LI.WIFI) {
    p.circ(x + w/6, y + h - 2, 1, c)
    for (let ring = 1; ring <= 3; ring++) {
      const rr = ring * (w * 2 / 3) / 3
      for (let a = -52; a <= 52; a += 6) {
        const rad = (a - 90) * Math.PI / 180
        p.rect(Math.round(x+w/6 + rr*Math.cos(rad)), Math.round(y+h-2 + rr*Math.sin(rad)), 1, 2, c)
      }
    }
  }
  else if (icon === LI.CLOCK) { g.strokeStyle=c; g.beginPath(); g.arc(cx,cy,r-1,0,7); g.stroke(); p.ln(cx,cy,cx,cy-r+3,c); p.ln(cx,cy,cx+r/2,cy,c) }
  else if (icon === LI.BATTERY) { p.ln(x,y+1,x+w-4,y+1,c); p.ln(x,y+h-2,x+w-4,y+h-2,c); p.rect(x+3,y+4,Math.floor((w-8)*2/3),h-6,c) }
  else if (icon === LI.BOLT) { p.tri(Math.floor(cx+w/6),y,x+w-1,Math.floor(y+h*0.42),Math.floor(x+w/4),Math.floor(y+h*0.42),c); p.tri(Math.floor(cx-w/6),Math.floor(y+h*0.58),Math.floor(x+w*0.75),Math.floor(y+h*0.58),x,y+h-1,c) }
  else if (icon === LI.STAR) { for (let i=0;i<5;i++){ const a1=(-90+i*144)*Math.PI/180, a2=(-90+(i+2)*144)*Math.PI/180; p.ln(cx+r*Math.cos(a1),cy+r*Math.sin(a1),cx+r*Math.cos(a2),cy+r*Math.sin(a2),c) } }
  else if (icon === LI.WHALE) {
    const s = Math.max(1, Math.floor(r/4))
    p.rect(x+Math.floor(w/4), cy-s, Math.floor(w/2)+2, s*2, c)
    p.circ(x+Math.floor(w/4), cy, s*2, c); p.circ(cx+Math.floor(w/6), cy, s*2, c)
    p.tri(cx+Math.floor(w/5), cy, x+w-1, cy-s*2, x+w-1, cy+Math.floor(s/2), c)
    p.tri(cx-Math.floor(w/12), cy-s, cx, y+1, cx+Math.floor(w/12), cy-s, c)
  }
}

function drawLayout() {
  const cv = $('lay-canvas'); if (!cv) return
  const g = cv.getContext('2d')
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, cv.width, cv.height)
  g.setTransform(LZ, 0, 0, LZ, 0, 0)
  g.fillStyle = lp('bg'); g.fillRect(0, 0, 160, 128)

  LAY.els.forEach(function (e) {
    if (!e.on) return
    const c = resolveC(e.c)
    if (e.t === LT.RECT) layRect(g, e.x, e.y, e.w, e.h, c)
    else if (e.t === LT.ROUND) layRound(g, e.x, e.y, e.w, e.h, e.r || 6, c)
    else if (e.t === LT.CIRCLE) layCircle(g, e.x + e.w/2, e.y + e.h/2, Math.min(e.w, e.h)/2, c)
    else if (e.t === LT.TRI) { g.fillStyle = c; g.beginPath(); g.moveTo(e.x+e.w/2,e.y); g.lineTo(e.x+e.w,e.y+e.h); g.lineTo(e.x,e.y+e.h); g.closePath(); g.fill() }
    else if (e.t === LT.LINE) layRect(g, e.x, e.y, e.w, Math.max(1, e.h), c)
    else if (e.t === LT.ICON) layIcon(g, e.icon, e.x, e.y, e.w || 10, e.h || 10, c, lp('bg'))
    else if (e.t === LT.PROGRESS) {
      layRect(g, e.x, e.y, e.w, e.h, lp('card2'))
      const pct = (LAST_STATUS && LAST_STATUS.pct) || 12
      const fw = Math.round(e.w * pct / 100)
      if (fw > 0) layRect(g, e.x, e.y, fw, e.h, c)
      layCircle(g, Math.max(e.x+3, Math.min(e.x+e.w-3, e.x+fw)), e.y + e.h/2, 2, c)
    }
    else if (e.t === LT.HBAR) {
      const n = 12, bw = Math.max(1, Math.floor(e.w/n) - 1)
      for (let i = 0; i < n; i++) {
        const bh = Math.round((0.3 + 0.7 * Math.abs(Math.sin(i * 0.8))) * (e.h - 2)) + 2
        layRect(g, e.x + i*(bw+1), e.y + e.h - bh, bw, bh, c)
      }
    }
    else if (e.t === LT.TEXT) {
      const s = (e.bind ? demoVal(e.bind) : e.text) || ''
      if (!s) return
      const sc = e.sz || 1
      g.fillStyle = c; g.textAlign = 'center'; g.textBaseline = 'top'
      let cx = e.x
      for (const ch of s) {
        if (ch.charCodeAt(0) < 128) { g.font = 'bold ' + Math.round(7*sc) + 'px monospace'; g.fillText(ch, cx+3*sc, e.y); cx += 6*sc }
        else { g.font = Math.round(12*sc) + 'px sans-serif'; g.fillText(ch, cx+6*sc, e.y); cx += 12*sc }
      }
    }
  })

  // 选中框 + 大号手柄（手指友好）
  const s = LAY.els.find(function (e) { return e.id === LAY.sel })
  if (s) {
    g.strokeStyle = '#0A84FF'; g.lineWidth = 1
    g.strokeRect(s.x - .5, s.y - .5, s.w + 1, s.h + 1)
    const hs = [[s.x,s.y],[s.x+s.w,s.y],[s.x,s.y+s.h],[s.x+s.w,s.y+s.h],[s.x+s.w,s.y+s.h/2],[s.x+s.w/2,s.y+s.h]]
    g.fillStyle = '#0A84FF'
    hs.forEach(function (q) { g.fillRect(q[0]-3, q[1]-3, 6, 6) })
  }
}

// ---------- 触摸/鼠标拖拽 ----------
const LAY_HANDLE = 8   // 手柄命中半径（屏像素，除以 LZ 后为逻辑像素）

function layPoint(ev) {
  const cv = $('lay-canvas'); if (!cv) return null
  const r = cv.getBoundingClientRect()
  const t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev
  return { x: (t.clientX - r.left) / r.width * 160, y: (t.clientY - r.top) / r.height * 128 }
}

let layDrag = null

function layDown(ev) {
  const p = layPoint(ev); if (!p) return
  const near = function (a, b) { return Math.abs(a - b) <= LAY_HANDLE / LZ }
  const s = LAY.els.find(function (e) { return e.id === LAY.sel })

  // 先判手柄
  if (s) {
    if (near(p.x, s.x) && near(p.y, s.y)) { layDrag = { mode:'rz', id:s.id, h:'tl', sx:p.x, sy:p.y, o:{...s} }; ev.preventDefault(); return }
    if (near(p.x, s.x+s.w) && near(p.y, s.y+s.h)) { layDrag = { mode:'rz', id:s.id, h:'br', sx:p.x, sy:p.y, o:{...s} }; ev.preventDefault(); return }
    if (near(p.x, s.x+s.w) && Math.abs(p.y - (s.y+s.h/2)) <= LAY_HANDLE/LZ) { layDrag = { mode:'rz', id:s.id, h:'r', sx:p.x, sy:p.y, o:{...s} }; ev.preventDefault(); return }
    if (near(p.y, s.y+s.h) && Math.abs(p.x - (s.x+s.w/2)) <= LAY_HANDLE/LZ) { layDrag = { mode:'rz', id:s.id, h:'b', sx:p.x, sy:p.y, o:{...s} }; ev.preventDefault(); return }
  }
  // 再判元素（从上往下）
  for (let i = LAY.els.length - 1; i >= 0; i--) {
    const e = LAY.els[i]
    if (!e.on) continue
    const hw = Math.max(e.w, 14), hh = Math.max(e.h, 10)
    if (p.x >= e.x && p.x <= e.x + hw && p.y >= e.y && p.y <= e.y + hh) {
      LAY.sel = e.id
      layDrag = { mode:'move', id:e.id, sx:p.x, sy:p.y, o:{...e} }
      layRenderAll()
      ev.preventDefault()
      return
    }
  }
  LAY.sel = null
  layRenderAll()
}

function layMove(ev) {
  if (!layDrag) return
  const p = layPoint(ev); if (!p) return
  const d = layDrag, o = d.o
  const dx = p.x - d.sx, dy = p.y - d.sy
  const S = function (v) { return Math.round(v) }   // 1px 精度（8px 吸附会太跳）
  const e = LAY.els.find(function (q) { return q.id === d.id })
  if (!e) return
  if (d.mode === 'move') {
    e.x = Math.max(0, Math.min(160 - e.w, S(o.x + dx)))
    e.y = Math.max(0, Math.min(128 - e.h, S(o.y + dy)))
  } else {
    if (d.h === 'br' || d.h === 'r') e.w = Math.max(4, S(o.w + dx))
    if (d.h === 'br' || d.h === 'b') e.h = Math.max(4, S(o.h + dy))
    if (d.h === 'tl') {
      const nw = Math.max(4, S(o.w - dx)), nh = Math.max(4, S(o.h - dy))
      e.x = S(o.x + (o.w - nw)); e.y = S(o.y + (o.h - nh)); e.w = nw; e.h = nh
    }
    if (e.x + e.w > 160) e.w = 160 - e.x
    if (e.y + e.h > 128) e.h = 128 - e.y
  }
  drawLayout()
  layUpdateProps()
  ev.preventDefault()
}

function layUp() { if (layDrag) { layDrag = null; layRenderList() } }

// ---------- 元素列表 / 属性面板 ----------
function layRenderList() {
  const box = $('lay-list'); if (!box) return
  box.innerHTML = ''
  LAY.els.slice().reverse().forEach(function (e) {
    const row = document.createElement('div')
    row.className = 'lay-row' + (e.id === LAY.sel ? ' sel' : '')
    row.innerHTML = '<span class="lay-t">' + LTNAME[e.t] + '</span>' +
      '<span class="lay-xy">' + e.x + ',' + e.y + ' ' + e.w + '×' + e.h +
      (e.bind ? ' → ' + LDNAME[e.bind] : (e.text ? ' “' + e.text + '”' : '')) + '</span>'

    // 显隐开关（不用 innerHTML 拼 input，直接建节点以便绑定事件）
    const sw = document.createElement('label')
    sw.className = 'lay-swbtn'
    const inp = document.createElement('input')
    inp.type = 'checkbox'
    inp.checked = !!e.on
    inp.addEventListener('change', function () { e.on = this.checked; layRenderAll() })
    const ic = document.createElement('i')
    sw.appendChild(inp)
    sw.appendChild(ic)
    row.appendChild(sw)

    row.addEventListener('click', function (ev) {
      if (ev.target === inp) return
      LAY.sel = e.id; layRenderAll()
    })
    box.appendChild(row)
  })
}

function layUpdateProps() {
  const s = LAY.els.find(function (e) { return e.id === LAY.sel })
  const box = $('lay-props')
  if (!box) return
  if (!s) { box.style.display = 'none'; return }
  box.style.display = 'block'
  setText('lay-selname', LTNAME[s.t] + ' #' + s.id)
  setText('lay-xyz', 'x ' + s.x + '  y ' + s.y + '  宽 ' + s.w + '  高 ' + s.h)
  const bindSel = $('lay-bind')
  if (bindSel) bindSel.value = String(s.bind || 0)
  const cp = $('lay-color')
  if (cp) cp.value = resolveC(s.c)
  // 字号（仅文本）
  const szBox = $('lay-sizes')
  if (szBox) {
    szBox.style.display = (s.t === LT.TEXT) ? 'flex' : 'none'
    szBox.innerHTML = ''
    if (s.t === LT.TEXT) {
      [1,2,3,4].forEach(function (n) {
        const b = document.createElement('button')
        b.className = (s.sz || 1) === n ? 'on' : ''
        b.textContent = '字号' + n
        b.addEventListener('click', function () { s.sz = n; layRenderAll() })
        szBox.appendChild(b)
      })
    }
  }
  // 图标
  const icBox = $('lay-icons')
  if (icBox) {
    icBox.style.display = (s.t === LT.ICON) ? 'flex' : 'none'
    icBox.innerHTML = ''
    if (s.t === LT.ICON) {
      LICONS.forEach(function (p) {
        const b = document.createElement('button')
        b.className = (s.icon === p[1]) ? 'on' : ''
        b.textContent = p[0]
        b.addEventListener('click', function () { s.icon = p[1]; layRenderAll() })
        icBox.appendChild(b)
      })
    }
  }
}

function layRenderAll() { drawLayout(); layRenderList(); layUpdateProps() }

// ---------- 分片写入（绕过 BLE MTU 限制） ----------
// 把长字符串拆成小块，每块带 <seq>|<total>| 头部，固件端拼接
const CHUNK = 180          // 每片字符数（BLE 默认 MTU 20 字节，协商后约 180 安全）

async function writeLong(ch, text) {
  const total = Math.max(1, Math.ceil(text.length / CHUNK))
  for (let i = 0; i < total; i++) {
    const body = text.substring(i * CHUNK, (i + 1) * CHUNK)
    const piece = i + '|' + total + '|' + body
    await writeChar(ch, piece)
    await sleep(60)        // 片间隔，避免丢包
  }
}

// ---------- 读取分片（固件分片回传） ----------
async function readLong(ch, maxWaitMs) {
  let buf = '', total = 1, got = 0
  const deadline = Date.now() + (maxWaitMs || 4000)
  while (Date.now() < deadline && got < total) {
    const txt = new TextDecoder().decode(await ch.readValue())
    const p1 = txt.indexOf('|')
    const p2 = p1 > 0 ? txt.indexOf('|', p1 + 1) : -1
    if (p2 > p1 && p1 <= 3) {
      const seq = parseInt(txt.substring(0, p1), 10)
      total = parseInt(txt.substring(p1 + 1, p2), 10) || 1
      if (seq === 0) { buf = ''; got = 0 }
      buf += txt.substring(p2 + 1)
      got++
    } else {
      // 不是分片格式，直接当整体
      return txt
    }
    if (got >= total) break
    await sleep(120)
  }
  return buf
}

// ---------- 发送到设备 ----------
function layExport() {
  const els = LAY.els.map(function (e) {
    const o = { t:e.t, x:e.x, y:e.y, w:e.w, h:e.h, c:(e.c || 'ink') }
    if (e.sz > 1) o.sz = e.sz
    if (e.r) o.r = e.r
    if (e.bind) o.bind = e.bind
    if (e.t === LT.ICON) o.icon = e.icon
    if (!e.on) o.on = 0
    if (e.text) o.text = e.text
    return o
  })
  return JSON.stringify({ elems: els })
}

async function laySend() {
  if (!requireConn()) return
  const payload = layExport()
  const btn = $('lay-send')
  if (btn) btn.disabled = true
  try {
    const ch = await bleService.getCharacteristic(BLE_CHAR_SETTINGS)
    const total = Math.ceil(payload.length / CHUNK)
    toast('发送中… ' + payload.length + ' 字节 / ' + total + ' 片', 1600)
    await writeLong(ch, payload)
    await sleep(900)
    // 读回确认
    try {
      const st = await bleService.getCharacteristic(BLE_CHAR_STATUS)
      const ack = new TextDecoder().decode(await st.readValue())
      if (ack.indexOf('"ok"') >= 0 && ack.indexOf('count') >= 0) {
        toast('✓ 设备已应用 ' + LAY.els.length + ' 个元素')
      } else {
        toast('已发送（设备回执：' + ack.slice(0, 40) + '）', 3500)
      }
    } catch (e2) {
      toast('已发送 ' + LAY.els.length + ' 个元素')
    }
  } catch (e) {
    toast(handleGattError(e), 4000)
  } finally {
    if (btn) btn.disabled = false
  }
}

async function layReload() {
  if (!requireConn()) return
  const btn = $('lay-reload')
  if (btn) btn.disabled = true
  try {
    const cmd = await bleService.getCharacteristic(BLE_CHAR_CMD)
    const st  = await bleService.getCharacteristic(BLE_CHAR_STATUS)

    // 第 1 步：问固件共几片，同时拿到第 0 片
    await writeChar(cmd, 'LAYOUT')
    await sleep(400)
    let txt = new TextDecoder().decode(await st.readValue())

    let p1 = txt.indexOf('|'), p2 = p1 > 0 ? txt.indexOf('|', p1 + 1) : -1
    if (p2 <= p1) {
      toast('设备未返回布局（固件可能较旧）', 3500)
      return
    }
    let total = parseInt(txt.substring(p1 + 1, p2), 10) || 1
    let buf = txt.substring(p2 + 1)

    // 第 2 步：逐片读取剩余部分
    for (let i = 1; i < total; i++) {
      await writeChar(cmd, 'LAYOUT:' + i)
      await sleep(280)
      let c = new TextDecoder().decode(await st.readValue())
      const q1 = c.indexOf('|'), q2 = q1 > 0 ? c.indexOf('|', q1 + 1) : -1
      if (q2 > q1) buf += c.substring(q2 + 1)
    }

    let d = {}
    try { d = JSON.parse(buf) } catch (e) {
      toast('布局解析失败（' + buf.length + ' 字节）', 3500)
      return
    }

    if (d.elems && d.elems.length) {
      LAY.els = d.elems.map(function (e, i) {
        return { id:i+1, t:e.t, x:e.x, y:e.y, w:e.w, h:e.h,
                 c:(typeof e.c === 'string' ? e.c : 'ink'),
                 sz:e.sz||1, r:e.r||0, bind:e.bind||0, icon:e.icon||0,
                 on:e.on !== 0, text:e.text||'' }
      })
      LAY.nextId = LAY.els.length + 1
      LAY.sel = null
      layRenderAll()
      toast('✓ 已读取 ' + LAY.els.length + ' 个元素（' + buf.length + ' 字节）')
    } else {
      toast('设备返回内容无 elems 字段', 3500)
    }
  } catch (e) {
    toast('读取失败：' + (e.message || e), 4000)
  } finally {
    if (btn) btn.disabled = false
  }
}

// ---------- 绑定事件 ----------
function layInit() {
  defaultLayout()

  const cv = $('lay-canvas')
  if (cv) {
    cv.addEventListener('mousedown', layDown)
    cv.addEventListener('touchstart', layDown, { passive: false })
    window.addEventListener('mousemove', layMove)
    window.addEventListener('touchmove', layMove, { passive: false })
    window.addEventListener('mouseup', layUp)
    window.addEventListener('touchend', layUp)
  }

  const bindSel = $('lay-bind')
  if (bindSel) {
    LDNAME.forEach(function (n, i) {
      const o = document.createElement('option')
      o.value = i; o.textContent = n
      bindSel.appendChild(o)
    })
    bindSel.addEventListener('change', function () {
      const s = LAY.els.find(function (e) { return e.id === LAY.sel })
      if (s) { s.bind = +this.value; layRenderAll() }
    })
  }

  const colBox = $('lay-colors')
  if (colBox) {
    ['ink','ink2','acc','ok','bad','card','card2','bar','bg'].forEach(function (k) {
      const b = document.createElement('button')
      b.className = 'lay-swatch'
      b.style.background = lp(k)
      b.title = k
      b.addEventListener('click', function () {
        const s = LAY.els.find(function (e) { return e.id === LAY.sel })
        if (s) { s.c = k; layRenderAll() }
      })
      colBox.appendChild(b)
    })
  }

  const cp = $('lay-color')
  if (cp) cp.addEventListener('input', function () {
    const s = LAY.els.find(function (e) { return e.id === LAY.sel })
    if (s) { s.c = this.value.toUpperCase(); layRenderAll() }
  })

  document.querySelectorAll('[data-nudge]').forEach(function (b) {
    b.addEventListener('click', function () {
      const s = LAY.els.find(function (e) { return e.id === LAY.sel }); if (!s) return
      const a = this.dataset.nudge.split(',').map(Number)
      s.x = Math.max(0, Math.min(160 - s.w, s.x + a[0]))
      s.y = Math.max(0, Math.min(128 - s.h, s.y + a[1]))
      layRenderAll()
    })
  })
  document.querySelectorAll('[data-size]').forEach(function (b) {
    b.addEventListener('click', function () {
      const s = LAY.els.find(function (e) { return e.id === LAY.sel }); if (!s) return
      const a = this.dataset.size.split(',').map(Number)
      s.w = Math.max(4, s.w + a[0]); s.h = Math.max(4, s.h + a[1])
      layRenderAll()
    })
  })

  function addEl(t) {
    const e = { id:LAY.nextId++, t:t, x:16, y:16, w:60, h:16, c:'ink',
                sz:1, r:(t === LT.ROUND ? 6 : 0), bind:0, icon:LI.DOT,
                on:true, text:(t === LT.TEXT ? '文字' : '') }
    if (t === LT.ICON) { e.w = 14; e.h = 14; e.c = 'acc' }
    if (t === LT.PROGRESS) { e.w = 120; e.h = 5; e.c = 'acc' }
    if (t === LT.HBAR) { e.w = 140; e.h = 28; e.c = 'acc' }
    LAY.els.push(e); LAY.sel = e.id; layRenderAll()
  }
  on('lay-add-text', 'click', function () { addEl(LT.TEXT) })
  on('lay-add-rect', 'click', function () { addEl(LT.ROUND) })
  on('lay-add-icon', 'click', function () { addEl(LT.ICON) })
  on('lay-add-prog', 'click', function () { addEl(LT.PROGRESS) })

  on('lay-dup', 'click', function () {
    const s = LAY.els.find(function (e) { return e.id === LAY.sel }); if (!s) return
    const n = Object.assign({}, s, { id:LAY.nextId++, x:s.x+4, y:s.y+4 })
    LAY.els.push(n); LAY.sel = n.id; layRenderAll()
  })
  on('lay-del', 'click', function () {
    LAY.els = LAY.els.filter(function (e) { return e.id !== LAY.sel })
    LAY.sel = null; layRenderAll()
  })
  on('lay-up', 'click', function () {
    const i = LAY.els.findIndex(function (e) { return e.id === LAY.sel })
    if (i < 0 || i >= LAY.els.length - 1) return
    const t = LAY.els[i]; LAY.els[i] = LAY.els[i+1]; LAY.els[i+1] = t; layRenderAll()
  })
  on('lay-down', 'click', function () {
    const i = LAY.els.findIndex(function (e) { return e.id === LAY.sel })
    if (i <= 0) return
    const t = LAY.els[i]; LAY.els[i] = LAY.els[i-1]; LAY.els[i-1] = t; layRenderAll()
  })

  on('lay-send', 'click', laySend)
  on('lay-reload', 'click', layReload)
  on('lay-default', 'click', function () { defaultLayout(); LAY.sel = null; layRenderAll(); toast('已恢复默认布局') })

  layRenderAll()
}

try { layInit() } catch (e) { console.error('[DS] 布局页初始化失败:', e) }

// ---------- 初始化（各自独立 try，互不影响） ----------
try { loadSettings() } catch (e) { console.error('[DS] loadSettings 失败:', e) }
try { drawPreview() } catch (e) { console.error('[DS] drawPreview 失败:', e) }

// 启动提示
setTimeout(function () {
  if (!bleService) toast('点「连接设备」开始', 2600);
}, 800);

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
