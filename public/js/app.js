const API_BASE = '/api/game';

let userAddress = '';
let userPublicKeyBase64 = '';
let userSecretKey = null; // Uint8Array
let selectedLandId = null;
let selectedStockId = null;

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
  document.getElementById('btn-takeover-land').addEventListener('click', () => handleLandAction('takeover'));
  document.getElementById('btn-levelup-land').addEventListener('click', handleLandLevelUp);

  // 株式アクション
  document.getElementById('btn-buy-stock').addEventListener('click', () => handleStockAction('buy'));
  document.getElementById('btn-sell-stock').addEventListener('click', () => handleStockAction('sell'));

  // デポジット・出金アクション
  document.getElementById('btn-send-kc-to-admin').addEventListener('click', handleKCSendToAdmin);
  document.getElementById('btn-withdraw').addEventListener('click', handleWithdraw);
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
  updateStocksList();
  updateLogs();
}

// ユーザーステータス（残高含む）取得
async function updateUserStatus() {
  try {
    const res = await fetch(`${API_BASE}/status/${userAddress}`);
    const data = await res.json();
    if (data.success) {
      document.getElementById('display-cash').innerText = data.user.balance_cash.toFixed(2);
      
      // KCサーバーからウォレット残高を取得
      const kcRes = await fetch(`${API_BASE}/kc-proxy/balance/${userAddress}`);
      if (kcRes.ok) {
        const kcData = await kcRes.json();
        document.getElementById('display-kc-balance').innerText = kcData.balance.toFixed(2);
      }
    }
  } catch (e) {}
}

// 共有土地マップ更新
async function updateLandsMap() {
  try {
    const res = await fetch(`${API_BASE}/lands`);
    const data = await res.json();
    if (!data.success) return;

    const grid = document.getElementById('grid-map');
    
    // 現在の選択セルを維持するためIDを控える
    const beforeGridLength = grid.children.length;
    
    // マスデータの並び替え(座標基準で4x4グリッド)
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
        cell.innerHTML = `
          <span class="cell-coords">${land.coordinate}</span>
          <span class="cell-name">${land.name}</span>
          <span class="cell-level"></span>
          <span class="cell-owner"></span>
          <span class="cell-price"></span>
        `;
        cell.addEventListener('click', () => selectLand(land.id));
        grid.appendChild(cell);
      });
    }

    // 各マスの状態更新
    lands.forEach(land => {
      const cell = grid.querySelector(`[data-id="${land.id}"]`);
      if (!cell) return;

      const ownerSpan = cell.querySelector('.cell-owner');
      const priceSpan = cell.querySelector('.cell-price');
      const levelSpan = cell.querySelector('.cell-level');

      // 建物レベルの判定
      let levelText = 'マンション';
      const rr = parseFloat(land.rent_rate);
      if (rr <= 0.015) levelText = '🏢 マンション';
      else if (rr <= 0.035) levelText = '🏢 オフィスビル';
      else levelText = '🗼 タワマン';

      // 土地タイプの判定 (id%3)
      const typeNum = land.id % 3;
      let typeClass = 'land-residential';
      if (typeNum === 1) typeClass = 'land-commercial';
      if (typeNum === 2) typeClass = 'land-industrial';

      if (land.owner_address) {
        cell.className = `map-cell owned ${typeClass}`;
        levelSpan.innerText = levelText;
        if (land.owner_address === userAddress) {
          cell.classList.add('my-land');
          ownerSpan.innerText = 'あなた';
        } else {
          ownerSpan.innerText = land.owner_name || land.owner_address.slice(0, 8);
        }
        priceSpan.innerText = `買収: ${land.purchase_price ? (land.purchase_price * 1.5).toFixed(0) : ''} Cash`;
      } else {
        cell.className = 'map-cell land-empty';
        levelSpan.innerText = '';
        ownerSpan.innerText = '空き地';
        priceSpan.innerText = `定価: ${land.base_price} Cash`;
      }

      if (selectedLandId === land.id) {
        cell.classList.add('selected');
        // 詳細パネルの更新
        document.getElementById('land-name').innerText = land.name;
        document.getElementById('land-coordinate').innerText = land.coordinate;
        document.getElementById('land-owner').innerText = land.owner_address === userAddress ? 'あなた' : (land.owner_name || (land.owner_address ? land.owner_address.slice(0, 8) : 'なし'));
        
        let levelText = 'マンション';
        const rr = parseFloat(land.rent_rate);
        if (rr <= 0.015) levelText = 'マンション';
        else if (rr <= 0.035) levelText = 'オフィスビル';
        else levelText = 'タワーマンション';
        document.getElementById('land-level').innerText = levelText;

        document.getElementById('land-base-price').innerText = land.base_price.toFixed(0);
        document.getElementById('land-purchase-price').innerText = land.purchase_price ? land.purchase_price.toFixed(0) : '---';
        document.getElementById('land-rent').innerText = (land.purchase_price ? land.purchase_price * rr : land.base_price * rr).toFixed(1) + '/30秒';

        const btnBuy = document.getElementById('btn-buy-land');
        const btnTakeover = document.getElementById('btn-takeover-land');
        const btnLevelUp = document.getElementById('btn-levelup-land');

        if (land.owner_address) {
          btnBuy.classList.add('hidden');
          if (land.owner_address === userAddress) {
            btnTakeover.classList.add('hidden');
            btnLevelUp.classList.remove('hidden');
            
            // レベルに応じたコストの計算
            if (rr <= 0.015) {
              const cost = land.base_price * 1.5;
              btnLevelUp.innerText = `オフィスビルへ改築 (${cost.toFixed(0)} Cash)`;
              btnLevelUp.disabled = false;
            } else if (rr <= 0.035) {
              const cost = land.base_price * 3.0;
              btnLevelUp.innerText = `タワーマンションへ改築 (${cost.toFixed(0)} Cash)`;
              btnLevelUp.disabled = false;
            } else {
              btnLevelUp.innerText = '最大レベル（タワマン）です';
              btnLevelUp.disabled = true;
            }
          } else {
            btnTakeover.classList.remove('hidden');
            btnLevelUp.classList.add('hidden');
            btnTakeover.innerText = `強制買収 (${(land.purchase_price * 1.5).toFixed(0)} Cash)`;
          }
        } else {
          btnBuy.classList.remove('hidden');
          btnTakeover.classList.add('hidden');
          btnLevelUp.classList.add('hidden');
        }
      }
    });

  } catch (e) {}
}

function selectLand(id) {
  selectedLandId = id;
  const cells = document.querySelectorAll('.map-cell');
  cells.forEach(c => c.classList.remove('selected'));
  
  const targetCell = document.querySelector(`[data-id="${id}"]`);
  if (targetCell) targetCell.classList.add('selected');

  document.getElementById('land-detail-panel').classList.remove('hidden');
  document.getElementById('land-action-msg').innerText = '';
}

// 土地購入・買収の実行
async function handleLandAction(actionType) {
  if (!selectedLandId) return;
  const endpoint = actionType === 'buy' ? '/lands/buy' : '/lands/takeover';
  const msgEl = document.getElementById('land-action-msg');
  msgEl.innerText = '処理中...';

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: userAddress,
        landId: selectedLandId
      })
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

// 土地のレベルアップ実行
async function handleLandLevelUp() {
  if (!selectedLandId) return;
  const msgEl = document.getElementById('land-action-msg');
  msgEl.innerText = '改築中...';

  try {
    const res = await fetch(`${API_BASE}/lands/levelup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: userAddress,
        landId: selectedLandId
      })
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

// 株式リスト更新
async function updateStocksList() {
  try {
    const res = await fetch(`${API_BASE}/stocks`);
    const data = await res.json();
    if (!data.success) return;

    // 保有株数の把握のため、ユーザーステータスも同時に参照
    const userRes = await fetch(`${API_BASE}/status/${userAddress}`);
    const userData = await userRes.json();
    const myHoldings = userData.success ? userData.stocks : [];

    const list = document.getElementById('stock-list');
    const beforeListLength = list.children.length;

    if (beforeListLength === 0) {
      list.innerHTML = '';
      data.stocks.forEach(stock => {
        const card = document.createElement('div');
        card.className = 'stock-card';
        card.dataset.id = stock.id;
        card.innerHTML = `
          <div class="stock-info">
            <span class="stock-symbol">${stock.symbol}</span>
            <span class="stock-name">${stock.company_name}</span>
          </div>
          <div class="stock-values">
            <div class="stock-price">${parseFloat(stock.current_price).toFixed(2)} Cash</div>
            <div class="stock-div">配当: ${parseFloat(stock.dividend_yield).toFixed(2)}%</div>
          </div>
        `;
        card.addEventListener('click', () => selectStock(stock.id));
        list.appendChild(card);
      });
    }

    // 各カードの状態更新
    data.stocks.forEach(stock => {
      const card = list.querySelector(`[data-id="${stock.id}"]`);
      if (!card) return;

      const priceDiv = card.querySelector('.stock-price');
      priceDiv.innerText = `${parseFloat(stock.current_price).toFixed(2)} Cash`;

      const holding = myHoldings.find(h => h.id === stock.id);
      const heldQty = holding ? holding.quantity : 0;

      if (selectedStockId === stock.id) {
        card.classList.add('selected');
        document.getElementById('trade-stock-name').innerText = `${stock.company_name} (${stock.symbol})`;
        document.getElementById('trade-stock-price').innerText = stock.current_price.toFixed(2);
        document.getElementById('trade-user-qty').innerText = heldQty;
      } else {
        card.classList.remove('selected');
      }
    });

  } catch (e) {}
}

function selectStock(id) {
  selectedStockId = id;
  const cards = document.querySelectorAll('.stock-card');
  cards.forEach(c => c.classList.remove('selected'));
  
  const targetCard = document.querySelector(`[data-id="${id}"]`);
  if (targetCard) targetCard.classList.add('selected');

  document.getElementById('stock-trade-panel').classList.remove('hidden');
  document.getElementById('stock-action-msg').innerText = '';
}

// 株式売買の実行
async function handleStockAction(type) {
  if (!selectedStockId) return;
  const qty = parseInt(document.getElementById('trade-qty-input').value);
  const msgEl = document.getElementById('stock-action-msg');
  if (isNaN(qty) || qty <= 0) {
    alert('数量を正しく入力してください');
    return;
  }

  msgEl.innerText = '取引中...';

  try {
    const res = await fetch(`${API_BASE}/stocks/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: userAddress,
        stockId: selectedStockId,
        type: type,
        quantity: qty
      })
    });
    const data = await res.json();
    if (data.success) {
      msgEl.innerText = data.message;
      updateStocksList();
      updateUserStatus();
    } else {
      msgEl.innerText = `エラー: ${data.error}`;
    }
  } catch (e) {
    msgEl.innerText = '通信エラーが発生しました';
  }
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
  } catch (e) {}
}

// --- KC送受金連携処理 ---

// 運営アドレス（ゲームサーバーから初回取得）
let adminWalletAddress = '';

// 1. KCサーバーへの送金 (デポジットステップ1)
async function handleKCSendToAdmin() {
  const amount = parseFloat(document.getElementById('deposit-amount-input').value);
  const msgEl = document.getElementById('deposit-msg');
  if (isNaN(amount) || amount <= 0) {
    alert('金額を正しく入力してください');
    return;
  }

  msgEl.innerText = '運営ウォレットアドレスを照会中...';

  try {
    // 運営アドレスを擬似的にゲームサーバーのログイン・設定から抽出するか、
    // ここではデモ用シードから算出した運営アドレスを固定（server.jsと一致）
    const seed = new Uint8Array(32);
    seed.fill(7);
    const adminKeyPairObj = nacl.sign.keyPair.fromSeed(seed);
    const adminPubKeyBase64 = nacl.util.encodeBase64(adminKeyPairObj.publicKey);
    
    // アドレス算出
    const pubBytes = nacl.util.decodeBase64(adminPubKeyBase64);
    const hashBuffer = await crypto.subtle.digest('SHA-256', pubBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    adminWalletAddress = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);

    msgEl.innerText = 'KCサーバーから送信元のnonceを取得中...';

    // 1. KCサーバーから現在の送信者(ユーザー)のnonceを取得
    const balRes = await fetch(`${API_BASE}/kc-proxy/balance/${userAddress}`);
    if (!balRes.ok) {
      const errData = await balRes.text(); msgEl.innerText = 'KC Server Error: ' + balRes.status + ' - ' + errData + '先にKCサーバーで招待コードを使用してウォレットを登録してください。';
      return;
    }
    const balData = await balRes.json();
    const nonce = balData.nonce;

    msgEl.innerText = 'トランザクションに署名中...';

    // 2. 署名の作成 (from:to:amount:nonce)
    const message = `${userAddress}:${adminWalletAddress}:${amount}:${nonce}`;
    const msgBytes = nacl.util.decodeUTF8(message);
    const signatureBytes = nacl.sign.detached(msgBytes, userSecretKey);
    const signature = nacl.util.encodeBase64(signatureBytes);

    msgEl.innerText = 'KCを送金中...';

    // 3. KCサーバーへ直接送金リクエスト
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
      msgEl.innerText = `送金成功 (txId: ${sendData.txId})。ゲーム内残高へ自動反映中...`;
      
      // 自動デポジット反映の実行
      try {
        const claimRes = await fetch(`${API_BASE}/deposit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: userAddress,
            txId: sendData.txId
          })
        });
        const claimData = await claimRes.json();
        if (claimData.success) {
          msgEl.innerText = `🎉 デポジットが完了しました！ ${amount} Cash をゲーム内に反映しました。`;
          updateUserStatus();
        } else {
          msgEl.innerText = `送金は成功しましたが、ゲーム内反映に失敗しました: ${claimData.error}`;
        }
      } catch (err) {
        msgEl.innerText = '送金成功後のゲーム内反映通信でエラーが発生しました。';
      }
    } else {
      msgEl.innerText = `送金失敗: ${sendData.error}`;
    }
  } catch (e) {
    msgEl.innerText = 'KCサーバーとの通信に失敗しました。';
  }
}

// 3. 出金処理
async function handleWithdraw() {
  const amount = parseFloat(document.getElementById('withdraw-amount-input').value);
  const msgEl = document.getElementById('withdraw-msg');
  if (isNaN(amount) || amount <= 0) {
    alert('出金額を正しく入力してください');
    return;
  }

  msgEl.innerText = '出金処理を実行中...';

  try {
    const res = await fetch(`${API_BASE}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: userAddress,
        amount: amount
      })
    });
    const data = await res.json();
    if (data.success) {
      msgEl.innerText = data.message;
      updateUserStatus();
    } else {
      msgEl.innerText = `出金エラー: ${data.error}`;
    }
  } catch (e) {
    msgEl.innerText = '通信エラーが発生しました';
  }
}





