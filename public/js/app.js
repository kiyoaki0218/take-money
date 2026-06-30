const API_BASE = '/api/game';
let selectedLandId = null;
let currentLands = [];
let userAddress = null;
let userSecretKey = null;
let userPublicKeyBase64 = null;
let userNickname = null;

function selectLand(id) {
  selectedLandId = id;
  const cells = document.querySelectorAll('.map-cell');
  cells.forEach(c => c.classList.remove('selected'));
  
  const targetCell = document.querySelector(`[data-id="${id}"]`);
  if (targetCell) targetCell.classList.add('selected');

  document.getElementById('land-detail-panel').classList.remove('hidden');
  document.getElementById('land-action-msg').innerText = '';
  
  updateLandDetailPanel(id);
}

function updateLandDetailPanel(id) {
  if (!currentLands) return;
  const land = currentLands.find(l => l.id === id);
  if (!land) return;

  document.getElementById('land-name').innerText = land.name;
  document.getElementById('land-owner').innerText = land.owner_name || 'なし (未所有)';
  document.getElementById('land-coordinate').innerText = land.coordinate;
  
  let levelText = 'なし';
  if (land.type === '住宅地') {
    if (land.rent_rate <= 0.015) levelText = '住宅地 (Lv1)';
    else if (land.rent_rate <= 0.035) levelText = 'マンション (Lv2)';
    else levelText = 'タワーマンション (Lv3)';
  } else if (land.type === '商業地') {
    if (land.rent_rate <= 0.020) levelText = '商業地 (Lv1)';
    else if (land.rent_rate <= 0.045) levelText = 'ショッピングモール (Lv2)';
    else levelText = '巨大テーマパーク (Lv3)';
  } else if (land.type === '工業地') {
    if (land.rent_rate <= 0.025) levelText = '工業地 (Lv1)';
    else if (land.rent_rate <= 0.055) levelText = '大規模工場 (Lv2)';
    else levelText = 'ハイテク研究所 (Lv3)';
  }
  document.getElementById('land-level').innerText = levelText;

  
  let cost = 0;
  const rr = parseFloat(land.rent_rate);
  const bp = parseFloat(land.base_price);
  if (land.type === '住宅地') {
    if (rr <= 0.015) cost = bp * 1.5;
    else if (rr <= 0.035) cost = bp * 3.0;
  } else if (land.type === '商業地') {
    if (rr <= 0.020) cost = bp * 2.0;
    else if (rr <= 0.045) cost = bp * 4.0;
  } else if (land.type === '工業地') {
    if (rr <= 0.025) cost = bp * 2.5;
    else if (rr <= 0.055) cost = bp * 5.0;
  }

  const sellPrice = land.purchase_price ? Math.floor(land.purchase_price * 0.8) : 0;

  document.getElementById('land-base-price').innerText = land.base_price.toLocaleString() + (cost > 0 ? ` (次LvUP: ${cost.toLocaleString()} KC)` : '');
  if(document.getElementById('land-sell-price')) {
     document.getElementById('land-sell-price').innerText = sellPrice.toLocaleString();
  }

  document.getElementById('land-purchase-price').innerText = land.purchase_price ? land.purchase_price.toLocaleString() : '0';
  document.getElementById('land-rent').innerText = land.purchase_price ? Math.round(land.purchase_price * land.rent_rate).toLocaleString() : '0';

  const btnBuy = document.getElementById('btn-buy-land');
  const btnTakeover = document.getElementById('btn-takeover-land');
  const btnLevelUp = document.getElementById('btn-levelup-land');
  const btnSell = document.getElementById('btn-sell-land');
  const buildOptions = document.getElementById('build-options');

  // Reset display
  btnBuy.classList.add('hidden');
  btnTakeover.classList.add('hidden');
  btnLevelUp.classList.add('hidden');
  btnSell.classList.add('hidden');
  buildOptions.classList.add('hidden');

  if (!land.owner_address) {
    // 誰も所有していない空き地
    btnBuy.classList.remove('hidden');
  } else if (land.owner_address === userAddress) {
    // 自分の土地
    if (land.type === '空き地') {
      buildOptions.classList.remove('hidden');
      btnSell.classList.remove('hidden');
    } else {
      btnLevelUp.classList.remove('hidden');
      btnSell.classList.remove('hidden');
    }
  } else {
    // 他人の土地
    btnTakeover.classList.remove('hidden');
  }
}

﻿

// ドキュメント読み込み完了時
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  autoLoginIfSaved();
});

// イベントリスナーのセットアップ
function setupEventListeners() {
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-disconnect').addEventListener('click', handleDisconnect);
  
  // 土地アクション
  document.getElementById('btn-buy-land').addEventListener('click', () => handleLandAction('buy'));
  document.getElementById('btn-build-residential').addEventListener('click', () => handleBuild('residential'));
  document.getElementById('btn-build-commercial').addEventListener('click', () => handleBuild('commercial'));
  document.getElementById('btn-build-industrial').addEventListener('click', () => handleBuild('industrial'));
  document.getElementById('btn-takeover-land').addEventListener('click', () => handleLandAction('takeover'));
  document.getElementById('btn-levelup-land').addEventListener('click', handleLandLevelUp);
  document.getElementById('btn-sell-land').addEventListener('click', handleLandSell);

    // デポジット・出金アクション
  
  
}

// 保存されたキーがあれば自動ログイン
function autoLoginIfSaved() {
  const savedSec = localStorage.getItem('kc_secret');
  const savedNick = localStorage.getItem('kc_nickname');
  if (savedSec && savedNick) {
    document.getElementById('private-key-input').value = savedSec;
    document.getElementById('nickname-input').value = savedNick;
    handleLogin();
  }
}

// 接続（ログイン）処理
async function handleLogin() {
  const nickname = document.getElementById('nickname-input').value.trim();
  let privKeyStr = document.getElementById('private-key-input').value.trim();

  if (!nickname) {
    alert('ニックネームを入力してください');
    return;
  }

  let keyPair;
  if (!privKeyStr) {
    // 新規生成
    keyPair = nacl.sign.keyPair();
    privKeyStr = nacl.util.encodeBase64(keyPair.secretKey);
  } else {
    try {
      const secBytes = nacl.util.decodeBase64(privKeyStr);
      keyPair = nacl.sign.keyPair.fromSecretKey(secBytes);
    } catch (e) {
      alert('無効な秘密鍵です');
      return;
    }
  }

  userSecretKey = keyPair.secretKey;
  userPublicKeyBase64 = nacl.util.encodeBase64(keyPair.publicKey);
  
  // アドレスの導出 (SHA-256)
  userAddress = await deriveAddress(userPublicKeyBase64);

  // サーバー登録
  try {
    const res = await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: userPublicKeyBase64,
        nickname: nickname
      })
    });
    
    const data = await res.json();
    if (!data.success) {
      alert(data.error);
      return;
    }

    // 保存
    localStorage.setItem('kc_secret', privKeyStr);
    localStorage.setItem('kc_nickname', nickname);

    // UI更新
    document.getElementById('login-modal').classList.add('hidden');
    document.getElementById('display-nickname').innerText = nickname;
    document.getElementById('display-address').innerText = userAddress.slice(0, 8) + '...';

    // ループ更新の開始
    startUpdateLoop();
  } catch (e) {
    alert('サーバーへの接続に失敗しました');
  }
}

// 切断処理
function handleDisconnect() {
  localStorage.removeItem('kc_secret');
  localStorage.removeItem('kc_nickname');
  window.location.reload();
}

// アドレス導出用の補助関数
async function deriveAddress(pubKeyBase64) {
  const pubBytes = nacl.util.decodeBase64(pubKeyBase64);
  const hashBuffer = await crypto.subtle.digest('SHA-256', pubBytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

// ループ更新
function startUpdateLoop() {
  updateAllData();
  setInterval(updateAllData, 2000); // 2秒ごと
}

function updateAllData() {
  updateUserStatus();
  updateLandsMap();
    updateLogs();
}

// ユーザーステータス（残高含む）取得
async function updateUserStatus() {
  try {
    const res = await fetch(`${API_BASE}/status/${userAddress}`);
    const data = await res.json();
    if (data.success) {
            // KCサーバーからウォレット残高を取得
      const kcRes = await fetch(`${API_BASE}/kc-proxy/balance/${userAddress}?t=${Date.now()}`, { cache: 'no-store' });
      if (kcRes.ok) {
        const kcData = await kcRes.json();
        document.getElementById('display-kc-balance').innerText = kcData.balance.toFixed(2);
      }
    }
  } catch (e) { console.error(e); }
}

// 共有土地マップ更新
async function updateLandsMap() {
  try {
    const res = await fetch(`${API_BASE}/lands`);
    const data = await res.json();
    if (!data.success) return;

    currentLands = data.lands;
    const grid = document.getElementById('grid-map');
    const beforeGridLength = grid.children.length;
    
    const lands = data.lands.sort((a, b) => {
      const [ax, ay] = a.coordinate.split(',').map(Number);
      const [bx, by] = b.coordinate.split(',').map(Number);
      return ay === by ? ax - bx : ay - by;
    });

    if (beforeGridLength === 0) {
      grid.innerHTML = '';
      lands.forEach(land => {
        const cell = document.createElement('div');
        cell.className = 'map-cell';
        cell.dataset.id = land.id;
        cell.addEventListener('click', () => selectLand(land.id));
        grid.appendChild(cell);
      });
    }

    lands.forEach(land => {
      const cell = grid.querySelector(`[data-id="${land.id}"]`);
      if (!cell) return;
      
      // Update color class
      cell.className = 'map-cell' + (land.id === selectedLandId ? ' selected' : '');
      if (land.type === '空き地') {
         if (land.owner_address) cell.classList.add('land-empty'); // 黒 (購入済空き地)
         // 未購入はデフォルトスタイル(白)のまま
      } else if (land.type === '住宅地') cell.classList.add('land-residential');
      else if (land.type === '商業地') cell.classList.add('land-commercial');
      else if (land.type === '工業地') cell.classList.add('land-industrial');

      // Highlight user's land with a subtle border if not selected
      if (land.owner_address === userAddress && land.id !== selectedLandId) {
        cell.classList.add('my-land');
      }
    });

    if (selectedLandId) {
      updateLandDetailPanel(selectedLandId);
    }
  } catch (e) { console.error(e); }
}

// ニュースログの更新
async function updateLogs() {
  try {
    const res = await fetch(`${API_BASE}/logs`);
    const data = await res.json();
    if (!data.success) return;

    const list = document.getElementById('log-list');
    list.innerHTML = '';
    
    data.logs.forEach(log => {
      const item = document.createElement('div');
      item.className = 'log-item';
      item.innerText = `[${log.id}] ${log.message}`;
      list.appendChild(item);
    });
  } catch (e) { console.error(e); }
}

// --- KC送受金連携処理 ---

// 運営アドレス（ゲームサーバーから初回取得）
let adminWalletAddress = '';

// 1. KCサーバーへの送金 (デポジットステップ1)

// 3. 出金処理






// 支払いトランザクション用ヘルパー
async function sendKCToAdmin(amount) {
  try {
    const seed = new Uint8Array(32);
    seed.fill(7);
    const adminKeyPair = nacl.sign.keyPair.fromSeed(seed);
    const pubBytes = adminKeyPair.publicKey;
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', pubBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const adminWalletAddress = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);

    const nonce = Date.now().toString();
    const message = `${userAddress}:${adminWalletAddress}:${amount}:${nonce}`;
    const msgBytes = nacl.util.decodeUTF8(message);
    const signatureBytes = nacl.sign.detached(msgBytes, userSecretKey);
    const signature = nacl.util.encodeBase64(signatureBytes);

    const sendRes = await fetch(`${API_BASE}/kc-proxy/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: userAddress,
        to: adminWalletAddress,
        amount: amount,
        nonce: nonce,
        signature: signature,
        publicKey: userPublicKeyBase64
      })
    });
    
    const sendData = await sendRes.json();
    if (sendData.success) {
      return sendData.txId;
    } else {
      console.error("Payment failed:", sendData.error);
      return null;
    }
  } catch (e) {
    console.error("Payment error:", e);
    return null;
  }
}

async function handleBuild(type) {
  if (!selectedLandId) return;
  let cost = 0;
  let typeName = '';
  if (type === 'residential') { cost = 5000000; typeName = '住宅地'; }
  else if (type === 'commercial') { cost = 10000000; typeName = '商業施設'; }
  else if (type === 'industrial') { cost = 15000000; typeName = '工場'; }

  const msgEl = document.getElementById('land-action-msg');
  msgEl.innerText = `KCウォレットから ${cost} KC を送金中...`;

  const txId = await sendKCToAdmin(cost);
  if (!txId) {
    msgEl.innerText = '支払いに失敗しました';
    return;
  }
  msgEl.innerText = '支払い完了。ゲームに反映中...';

  try {
    const res = await fetch(`${API_BASE}/lands/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: userAddress, landId: selectedLandId, type, txId })
    });
    const data = await res.json();
    if (data.success) {
      msgEl.innerText = data.message;
      updateLandsMap();
      updateUserStatus();
    } else {
      msgEl.innerText = data.error;
    }
  } catch (e) {
    msgEl.innerText = 'エラーが発生しました';
  }
}

async function handleLandAction(action) {
  if (!selectedLandId) return;
  const msgEl = document.getElementById('land-action-msg');
  msgEl.innerText = '処理中...';

  const land = currentLands.find(l => l.id === selectedLandId);
  if (!land) return;

  let cost = 0;
  if (action === 'buy') cost = land.base_price;
  if (action === 'takeover') cost = (land.purchase_price ? land.purchase_price : land.base_price) * 1.5;

  msgEl.innerText = `KCウォレットから ${cost} KC を送金中...`;
  const txId = await sendKCToAdmin(cost);
  if (!txId) {
    msgEl.innerText = '支払いに失敗しました';
    return;
  }
  msgEl.innerText = '支払い完了。ゲームに反映中...';

  try {
    const res = await fetch(`${API_BASE}/lands/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: userAddress, landId: selectedLandId, txId })
    });
    const data = await res.json();
    if (data.success) {
      msgEl.innerText = data.message;
      updateLandsMap();
      updateUserStatus();
    } else {
      msgEl.innerText = `エラー: ${data.error}`;
    }
  } catch (e) {
    msgEl.innerText = '通信エラーが発生しました';
  }
}

async function handleLandLevelUp() {
  if (!selectedLandId) return;
  const msgEl = document.getElementById('land-action-msg');
  
  const land = currentLands.find(l => l.id === selectedLandId);
  if (!land) return;

  const type = land.type; 
  const rr = parseFloat(land.rent_rate);
  const bp = parseFloat(land.base_price);
  let cost = 0;

  if (type === '住宅地') {
    if (rr <= 0.015) cost = bp * 1.5;
    else if (rr <= 0.035) cost = bp * 3.0;
  } else if (type === '商業地') {
    if (rr <= 0.020) cost = bp * 2.0;
    else if (rr <= 0.045) cost = bp * 4.0;
  } else if (type === '工業地') {
    if (rr <= 0.025) cost = bp * 2.5;
    else if (rr <= 0.055) cost = bp * 5.0;
  }
  if (cost === 0) {
    msgEl.innerText = '既に最大レベルです';
    return;
  }

  msgEl.innerText = `KCウォレットから ${cost} KC を送金中...`;
  const txId = await sendKCToAdmin(cost);
  if (!txId) {
    msgEl.innerText = '支払いに失敗しました';
    return;
  }
  msgEl.innerText = '支払い完了。ゲームに反映中...';

  try {
    const res = await fetch(`${API_BASE}/lands/levelup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: userAddress, landId: selectedLandId, txId })
    });
    const data = await res.json();
    if (data.success) {
      msgEl.innerText = data.message;
      updateLandsMap();
      updateUserStatus();
    } else {
      msgEl.innerText = `エラー: ${data.error}`;
    }
  } catch (e) {
    msgEl.innerText = '通信エラーが発生しました';
  }
}

async function handleLandSell() {
  if (!selectedLandId) return;
  if (!confirm('本当にこの土地を売却しますか？')) return;
  const msgEl = document.getElementById('land-action-msg');
  msgEl.innerText = '処理中...';

  try {
    const res = await fetch(`${API_BASE}/lands/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: userAddress, landId: selectedLandId })
    });
    const data = await res.json();
    if (data.success) {
      msgEl.innerText = data.message;
      updateLandsMap();
      updateUserStatus();
    } else {
      msgEl.innerText = `エラー: ${data.error}`;
    }
  } catch (e) {
    msgEl.innerText = '通信エラーが発生しました';
  }
}

// Theme Toggle Logic
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      if (current === 'dark') {
        document.documentElement.removeAttribute('data-theme');
        btn.innerText = '🌙 Dark';
        localStorage.setItem('theme', 'light');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        btn.innerText = '☀️ Light';
        localStorage.setItem('theme', 'dark');
      }
    });

    if (localStorage.getItem('theme') === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      btn.innerText = '☀️ Light';
    }
  }
});


