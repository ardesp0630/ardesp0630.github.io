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
  if (!t) { return; }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms || 2200);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const $ = id => document.getElementById(id);
function setText(id, v) { const e = $(id); if (e) e.textContent = v; }

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
  if (!bleService) { toast('请先连接设备'); return; }

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
  if (!bleService) { toast('请先连接设备'); return; }
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
async function refreshBalance() {
  if (!bleService) return;
  try {
    const ch = await bleService.getCharacteristic(BLE_CHAR_STATUS);
    const txt = new TextDecoder().decode(await ch.readValue());
    let d = {};
    try { d = JSON.parse(txt); } catch (e) { d = {}; }

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

// ---------- 按钮绑定 ----------
$('btn-scan').addEventListener('click', bleScan);
$('btn-disconnect').addEventListener('click', bleDisconnect);
$('btn-ble-send').addEventListener('click', bleSend);
$('btn-hotspot-send').addEventListener('click', () => {
  toast('热点步骤：连 WiFi「DS-Config」(密码 12345678) → 打开 192.168.4.1', 5000);
});
$('btn-send-set').addEventListener('click', sendSettings);
$('btn-reset-set').addEventListener('click', resetSettings);

// 余额概览卡片：点标题刷新
const balCard = $('home-bal');
if (balCard) {
  balCard.addEventListener('click', () => { refreshBalance(); toast('已刷新'); });
  balCard.style.cursor = 'pointer';
  balCard.title = '点击刷新余额';
}

// 设置项变化时实时重绘预览
SET_KEYS.forEach(k => {
  const e = $(SET_IDS[k]);
  if (e) e.addEventListener('change', drawPreview);
});
$('set-rot').addEventListener('change', drawPreview);

const briSlider = $('set-bri');
briSlider.addEventListener('input', () => {
  setText('bri-val', briSlider.value);
  drawPreview();
});

// 预览亮度联动（模拟背光）
briSlider.addEventListener('input', () => {
  const cv = $('screen-preview');
  if (cv) cv.style.filter = 'brightness(' + (0.35 + briSlider.value / 100 * 0.65) + ')';
});

loadSettings();
drawPreview();

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
