// DeepSeek 显示屏 - App 逻辑（模块3：蓝牙 BLE 配置）
const BLE_SERVICE     = 'd5f10001-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_SSID   = 'd5f10002-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_PWD    = 'd5f10003-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_KEY    = 'd5f10004-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_CMD    = 'd5f10005-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_STATUS = 'd5f10006-6f2a-4b6f-9a2a-8b0e2b7f9c01';
const BLE_CHAR_SETTINGS = 'd5f10007-6f2a-4b6f-9a2a-8b0e2b7f9c01';

let bleServer = null;
let bleService = null;
let bleDevice = null;
const enc = new TextEncoder();

// ---------- 页面切换 ----------
const tabs = document.querySelectorAll('.tabbtn');
tabs.forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabbtn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------- 配置表单：本机保存（localStorage） ----------
const inSsid = document.getElementById('in-ssid');
const inPwd  = document.getElementById('in-pwd');
const inKey  = document.getElementById('in-key');

function loadConfig() {
  const cfg = JSON.parse(localStorage.getItem('ds_cfg') || '{}');
  inSsid.value = cfg.ssid || '';
  inPwd.value  = cfg.pwd || '';
  inKey.value  = cfg.key || '';
  document.getElementById('cfg-ssid').textContent = cfg.ssid || '--';
  document.getElementById('cfg-key').textContent = cfg.key ? cfg.key.slice(0, 8) + '…' : '--';
}
function saveConfig() {
  const cfg = { ssid: inSsid.value.trim(), pwd: inPwd.value, key: inKey.value.trim() };
  localStorage.setItem('ds_cfg', JSON.stringify(cfg));
  document.getElementById('cfg-ssid').textContent = cfg.ssid || '--';
  document.getElementById('cfg-key').textContent = cfg.key ? cfg.key.slice(0, 8) + '…' : '--';
}
inSsid.addEventListener('change', saveConfig);
inPwd.addEventListener('change', saveConfig);
inKey.addEventListener('change', saveConfig);
loadConfig();

// ---------- 蓝牙（模块3） ----------
function setConn(on, text) {
  const b = document.getElementById('conn-badge');
  b.textContent = text || (on ? '已连接' : '未连接');
  b.className = 'badge ' + (on ? 'on' : 'off');
  document.getElementById('dev-status').textContent = on ? '在线' : '--';
}

async function bleScan() {
  if (!navigator.bluetooth) {
    alert('此浏览器不支持蓝牙。请用 Chrome/Edge，并通过 HTTPS 或 localhost 打开本页。');
    return;
  }
  try {
    setConn(false, '扫描中…');
    // acceptAllDevices + 按名称选，兼容 Windows 已配对设备不广播服务 UUID 的情况
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE]
    });
    bleServer = await device.gatt.connect();
    bleDevice = device;
    device.addEventListener('gattserverdisconnected', () => {
      bleService = null; bleServer = null;
      setConn(false, '已断开');
      document.getElementById('dev-info').textContent = '设备已断开，请重新扫描';
    });
    bleService = await bleServer.getPrimaryService(BLE_SERVICE);
    const st = await bleService.getCharacteristic(BLE_CHAR_STATUS);
    const val = await st.readValue();
    const status = new TextDecoder().decode(val);
    setConn(true, status === 'SAVED' ? '已保存' : '已连接');
    document.getElementById('dev-info').textContent = device.name || 'DS-Display';
  } catch (e) {
    setConn(false, '连接失败');
    document.getElementById('dev-info').textContent = e.message || String(e);
  }
}

async function writeChar(ch, value) {
  try {
    await ch.writeValue(enc.encode(value));
  } catch (e) {
    await ch.writeValueWithoutResponse(enc.encode(value));
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bleSend() {
  const ssid = inSsid.value.trim();
  const pwd  = inPwd.value;
  const key  = inKey.value.trim();
  if (!ssid || !key) { alert('请先填写 WiFi 名称和 API Key'); return; }
  if (!bleService) { alert('请先点「扫描设备」连接设备'); return; }
  const btn = document.getElementById('btn-ble-send');
  btn.disabled = true;
  try {
    const chSsid = await bleService.getCharacteristic(BLE_CHAR_SSID);
    const chPwd  = await bleService.getCharacteristic(BLE_CHAR_PWD);
    const chKey  = await bleService.getCharacteristic(BLE_CHAR_KEY);
    const chCmd  = await bleService.getCharacteristic(BLE_CHAR_CMD);
    await writeChar(chSsid, ssid); await sleep(300);
    await writeChar(chPwd, pwd);   await sleep(300);
    await writeChar(chKey, key);   await sleep(300);
    saveConfig();
    try { await writeChar(chCmd, 'SAVE'); } catch (e) { /* 设备保存后立即重启，响应可能丢失 */ }
    alert('已发送！设备保存配置并重启，观察屏幕是否连上新 WiFi。');
  } catch (e) {
    alert(handleGattError(e));
  } finally {
    btn.disabled = false;
  }
}

// ---------- 热点方式说明 ----------
function hotspotHelp() {
  alert('热点配置步骤：\n1. 设备进入配置模式后，手机连 WiFi「DS-Config」密码 12345678\n2. 浏览器打开 http://192.168.4.1\n3. 填写 WiFi/API Key，点保存并重启');
}

// ---------- 界面设置（模块B） ----------
function loadSettings() {
  const s = JSON.parse(localStorage.getItem('ds_set') || '{}');
  if (s.rows !== undefined) {
    document.getElementById('set-used').checked  = !!(s.rows & 1);
    document.getElementById('set-tok').checked   = !!(s.rows & 2);
    document.getElementById('set-polls').checked = !!(s.rows & 4);
    document.getElementById('set-wifi').checked  = !!(s.rows & 8);
    document.getElementById('set-pw').checked    = !!(s.rows & 16);
    document.getElementById('set-st').checked    = !!(s.rows & 32);
  }
  if (s.bri !== undefined) document.getElementById('set-bri').value = s.bri;
  if (s.poll !== undefined) document.getElementById('set-poll').value = s.poll;
  if (s.rot !== undefined) document.getElementById('set-rot').value = s.rot;
}

async function sendSettings() {
  if (!bleService) { alert('请先点「扫描设备」连接设备'); return; }
  const g = id => document.getElementById(id);
  const rows = (g('set-used').checked ? 1 : 0) | (g('set-tok').checked ? 2 : 0)
             | (g('set-polls').checked ? 4 : 0) | (g('set-wifi').checked ? 8 : 0)
             | (g('set-pw').checked ? 16 : 0) | (g('set-st').checked ? 32 : 0);
  const set = { rows, bri: +g('set-bri').value, poll: +g('set-poll').value, rot: +g('set-rot').value };
  localStorage.setItem('ds_set', JSON.stringify(set));
  try {
    const ch = await bleService.getCharacteristic(BLE_CHAR_SETTINGS);
    await writeChar(ch, JSON.stringify(set));
    alert('界面设置已发送，设备将应用并重启显示。');
  } catch (e) {
    alert(handleGattError(e));
  }
}

async function resetSettings() {
  ['set-used','set-tok','set-polls','set-wifi','set-pw','set-st'].forEach(id => document.getElementById(id).checked = true);
  document.getElementById('set-bri').value = 255;
  document.getElementById('set-poll').value = 60;
  document.getElementById('set-rot').value = 1;
  await sendSettings();
}

function handleGattError(e) {
  const msg = (e && e.message) ? e.message : String(e);
  if (msg.indexOf('disconnected') >= 0 || msg.indexOf('GATT') >= 0) {
    bleService = null;
    setConn(false, '已断开');
    return '设备已断开，请重新点「扫描设备」连接后再试';
  }
  return '发送失败：' + msg;
}
async function refreshBalance() {
  if (!bleService) { return; }   // 未连接时不弹错
  try {
    const ch = await bleService.getCharacteristic(BLE_CHAR_STATUS);
    const val = await ch.readValue();
    const txt = new TextDecoder().decode(val);
    let d = {};
    try { d = JSON.parse(txt); } catch (e) { d = {}; }
    const el = id => document.getElementById(id);
    el('bal-amount').textContent = (typeof d.bal === 'number') ? d.bal.toFixed(2) : '--';
    el('bal-status').textContent = d.avail === 1 ? 'AVAILABLE' : (d.avail === 0 ? 'LOW FUNDS' : '--');
    el('bal-time').textContent = d.time || '--';
  } catch (e) {
    // 连接已断开时不弹窗，等待自动重连/用户重扫
    if (e && e.message && e.message.indexOf('disconnected') >= 0) return;
    document.getElementById('bal-status').textContent = '读取失败';
  }
}

// 连接后自动刷新余额（每 15 秒）
setInterval(() => { if (bleService) refreshBalance(); }, 15000);

// ---------- 按钮绑定 ----------
document.getElementById('btn-scan').addEventListener('click', bleScan);
document.getElementById('btn-ble-send').addEventListener('click', bleSend);
document.getElementById('btn-hotspot-send').addEventListener('click', hotspotHelp);
document.getElementById('btn-refresh').addEventListener('click', refreshBalance);
document.getElementById('btn-send-set').addEventListener('click', sendSettings);
document.getElementById('btn-reset-set').addEventListener('click', resetSettings);
loadSettings();

// ---------- PWA 注册 ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
