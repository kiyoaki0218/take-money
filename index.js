const express = require('express');
const cors = require('cors');
const path = require('path');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const KC_SERVER_URL = process.env.KC_SERVER_URL || 'https://kc-server.vercel.app';

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// --- 運営ウォレットの設定 ---
let adminKeyPair = null;
let adminAddress = '';
let adminPublicKeyBase64 = '';
let isInitialized = false;

async function initAdminWallet() {
  try {
    const seed = new Uint8Array(32);
    seed.fill(7);
    const keyPair = nacl.sign.keyPair.fromSeed(seed);
    adminKeyPair = keyPair;
    
    adminPublicKeyBase64 = naclUtil.encodeBase64(keyPair.publicKey);
    
    const crypto = require('crypto');
    const pubBytes = Buffer.from(adminPublicKeyBase64, 'base64');
    adminAddress = crypto.createHash('sha256').update(pubBytes).digest('hex').slice(0, 40);
    
    console.log(`\n  🎮 Game Admin Wallet Address: ${adminAddress}`);
    
    const registerRes = await fetch(`${KC_SERVER_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: adminPublicKeyBase64,
        inviteCode: 'invite0000',
        nickname: 'take-money'
      })
    });
    const regData = await registerRes.json();
    console.log(`  🪙 KC Server Register Status:`, regData.message || regData.error || 'Registered');
  } catch (e) {
    console.log(`  ⚠️ KC Server connection failed. Run Fiction Money server on port 3000 to enable full integration.`);
  }
}

async function ensureInit(req, res, next) {
  if (!isInitialized) {
    await initAdminWallet();
    isInitialized = true;
  }
  next();
}

app.use('/api/game', ensureInit);

function verifySignature(message, signature, publicKey) {
  try {
    const msgBytes = naclUtil.decodeUTF8(message);
    const sigBytes = naclUtil.decodeBase64(signature);
    const pubBytes = naclUtil.decodeBase64(publicKey);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
  } catch (e) {
    return false;
  }
}

function addressFromPublicKey(publicKeyBase64) {
  const crypto = require('crypto');
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  return crypto.createHash('sha256').update(pubBytes).digest('hex').slice(0, 40);
}

function signMessage(message) {
  const msgBytes = naclUtil.decodeUTF8(message);
  const signatureBytes = nacl.sign.detached(msgBytes, adminKeyPair.secretKey);
  return naclUtil.encodeBase64(signatureBytes);
}

// 1. ユーザー登録
app.post('/api/game/register', async (req, res) => {
  const { publicKey, nickname } = req.body;
  if (!publicKey || !nickname) {
    return res.status(400).json({ success: false, error: '公開鍵とニックネームが必要です' });
  }

  const address = addressFromPublicKey(publicKey);
  try {
    const { data: existing, error: checkError } = await db.supabase
      .from('users')
      .select('*')
      .eq('address', address)
      .maybeSingle();

    if (checkError) throw checkError;

    if (existing) {
      return res.json({ success: true, user: existing, message: 'ログインしました' });
    }

    const { data: newUser, error: insertError } = await db.supabase
      .from('users')
      .insert([{ address, public_key: publicKey, nickname, balance_cash: 1000.0 }])
      .select()
      .single();

    if (insertError) throw insertError;

    // KCサーバーへの自動登録を試みる
    try {
      await fetch(`${KC_SERVER_URL}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: publicKey,
          inviteCode: 'invite0000'
        })
      });
    } catch (e) {
      console.log("KC Server auto-registration failed:", e.message);
    }

    await db.supabase.from('game_logs').insert([{ message: `新規プレイヤー「${nickname}」が参入しました！` }]);

    res.json({ success: true, user: newUser, message: 'アカウントを新規作成しました（初期資金 1000 Cashを付与）' });
  } catch (e) {
    console.error("Register Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 2. ユーザーステータス取得
app.get('/api/game/status/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const { data: user, error: userErr } = await db.supabase
      .from('users')
      .select('*')
      .eq('address', address)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user) {
      return res.status(404).json({ success: false, error: 'ユーザーが見つかりません' });
    }

    const { data: lands, error: landsErr } = await db.supabase
      .from('lands')
      .select('*')
      .eq('owner_address', address);

    if (landsErr) throw landsErr;

    const { data: stocksJoin, error: stocksErr } = await db.supabase
      .from('user_stocks')
      .select('quantity, stocks (id, symbol, company_name, current_price, dividend_yield)')
      .eq('address', address)
      .gt('quantity', 0);

    if (stocksErr) throw stocksErr;

    const formattedStocks = (stocksJoin || []).map(item => ({
      id: item.stocks.id,
      symbol: item.stocks.symbol,
      company_name: item.stocks.company_name,
      current_price: parseFloat(item.stocks.current_price),
      dividend_yield: parseFloat(item.stocks.dividend_yield),
      quantity: item.quantity
    }));

    res.json({ success: true, user, lands, stocks: formattedStocks });
  } catch (e) {
    console.error("Status Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 3. 土地一覧取得
app.get('/api/game/lands', async (req, res) => {
  try {
    const { data: lands, error: landsErr } = await db.supabase
      .from('lands')
      .select('*, users!lands_owner_address_fkey (nickname)');

    if (landsErr) throw landsErr;

    const formattedLands = lands.map(l => {
      const name = l.name === '空き地' ? `空き地 ${l.coordinate}` : `${l.name} ${l.coordinate}`;
      return {
        id: l.id,
        name: name,
        type: l.name,
        coordinate: l.coordinate,
        base_price: parseFloat(l.base_price),
        owner_address: l.owner_address,
        purchase_price: l.purchase_price ? parseFloat(l.purchase_price) : null,
        rent_rate: parseFloat(l.rent_rate),
        owner_name: l.users ? l.users.nickname : null
      };
    });

    res.json({ success: true, lands: formattedLands });
  } catch (e) {
    console.error("Lands Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 4. 土地の新規購入
app.post('/api/game/lands/buy', async (req, res) => {
  const { address, landId, txId } = req.body;
  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: land } = await db.supabase.from('lands').select('*').eq('id', landId).single();

    if (!user || !land) return res.status(404).json({ success: false, error: 'ユーザーまたは土地が見つかりません' });
    if (land.owner_address) return res.status(400).json({ success: false, error: 'この土地は既に所有されています。' });

    // Verify Payment
    const txRes = await fetch(`${KC_SERVER_URL}/api/transactions/${adminAddress}`);
    if (!txRes.ok) return res.status(500).json({ success: false, error: 'KCサーバーへの接続エラー' });
    const txData = await txRes.json();
    const tx = txData.transactions.find(t => t.id === txId || t.tx_id === txId);
    if (!tx || tx.to_addr !== adminAddress || tx.from_addr !== address) {
      return res.status(400).json({ success: false, error: '有効な支払いトランザクションが見つかりません' });
    }
    const amountPaid = parseFloat(tx.amountDisplay || (tx.amount / 1000000));
    if (amountPaid < parseFloat(land.base_price)) {
      return res.status(400).json({ success: false, error: '支払額が不足しています' });
    }
    
    // Check if already processed
    const { data: logExists } = await db.supabase.from('game_logs').select('id').like('message', `%txId: ${txId}%`).maybeSingle();
    if (logExists) return res.status(400).json({ success: false, error: 'この取引は既に処理されています' });

    const { data: recheck } = await db.supabase.from('lands').select('owner_address').eq('id', landId).single();
    if (recheck.owner_address) {
      const nonce = Date.now().toString();
      const sig = signMessage(`${adminAddress}:${address}:${amountPaid}:${nonce}`);
      await fetch(`${KC_SERVER_URL}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: adminAddress, to: address, amount: amountPaid, nonce, signature: sig, publicKey: adminPublicKeyBase64, nickname: 'take-money', senderName: 'take-money' }) });
      return res.status(400).json({ success: false, error: 'タッチの差で購入されました。返金されました。' });
    }

    await db.supabase.from('lands').update({ owner_address: address, purchase_price: parseFloat(land.base_price) }).eq('id', landId);

    await db.supabase.from('game_logs').insert([{ message: `🏠「${user.nickname}」が「${land.name} ${land.coordinate}」を購入しました！ (txId: ${txId})` }]);
    res.json({ success: true, message: `空き地を購入しました！` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 4.5. 土地への建築
app.post('/api/game/lands/build', async (req, res) => {
  const { address, landId, type, txId } = req.body;
  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: land } = await db.supabase.from('lands').select('*').eq('id', landId).single();

    if (!user || !land) return res.status(404).json({ success: false, error: '見つかりません' });
    if (land.owner_address !== address) return res.status(400).json({ success: false, error: '自分の土地にしか建築できません' });
    if (land.name !== '空き地') return res.status(400).json({ success: false, error: 'すでに建築されています' });

    let cost = 0;
    let nextRentRate = 0;
    let newName = '';
    
    if (type === 'residential') { cost = 5000000; newName = '住宅地'; nextRentRate = 0.015; }
    else if (type === 'commercial') { cost = 10000000; newName = '商業地'; nextRentRate = 0.020; }
    else if (type === 'industrial') { cost = 15000000; newName = '工業地'; nextRentRate = 0.025; }
    else return res.status(400).json({ success: false, error: '無効な建築タイプです' });

    const txRes = await fetch(`${KC_SERVER_URL}/api/transactions/${adminAddress}`);
    if (!txRes.ok) return res.status(500).json({ success: false, error: 'KCサーバーへの接続エラー' });
    const txData = await txRes.json();
    const tx = txData.transactions.find(t => t.id === txId || t.tx_id === txId);
    if (!tx || tx.to_addr !== adminAddress || tx.from_addr !== address) return res.status(400).json({ success: false, error: '有効な支払いが見つかりません' });
    const amountPaid = parseFloat(tx.amountDisplay || (tx.amount / 1000000));
    if (amountPaid < cost) return res.status(400).json({ success: false, error: '支払額が不足しています' });

    const { data: logExists } = await db.supabase.from('game_logs').select('id').like('message', `%txId: ${txId}%`).maybeSingle();
    if (logExists) return res.status(400).json({ success: false, error: '処理済みです' });

    const newPurchasePrice = parseFloat(land.purchase_price || land.base_price) + cost;
    await db.supabase.from('lands').update({ name: newName, rent_rate: nextRentRate, purchase_price: newPurchasePrice }).eq('id', landId);

    await db.supabase.from('game_logs').insert([{ message: `🏗️「${user.nickname}」が区画[${land.coordinate}]に「${newName}」を建築しました！ (txId: ${txId})` }]);
    res.json({ success: true, message: `${newName}を建築しました！` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5. 強制買収
app.post('/api/game/lands/takeover', async (req, res) => {
  const { address, landId, txId } = req.body;
  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: land } = await db.supabase.from('lands').select('*').eq('id', landId).single();

    if (!user || !land) return res.status(404).json({ success: false, error: 'ユーザーまたは土地が見つかりません' });
    if (!land.owner_address || land.owner_address === address) {
      return res.status(400).json({ success: false, error: '買収できない土地です' });
    }

    const currentPrice = land.purchase_price ? parseFloat(land.purchase_price) : parseFloat(land.base_price);
    const takeoverPrice = currentPrice * 1.5;

    const txRes = await fetch(`${KC_SERVER_URL}/api/transactions/${adminAddress}`);
    if (!txRes.ok) return res.status(500).json({ success: false, error: 'KCサーバーへの接続エラー' });
    const txData = await txRes.json();
    const tx = txData.transactions.find(t => t.id === txId || t.tx_id === txId);
    if (!tx || tx.to_addr !== adminAddress || tx.from_addr !== address) {
      return res.status(400).json({ success: false, error: '有効な支払いが見つかりません' });
    }
    const amountPaid = parseFloat(tx.amountDisplay || (tx.amount / 1000000));
    if (amountPaid < takeoverPrice) return res.status(400).json({ success: false, error: '支払額が買収価格に満たないです' });

    const { data: logExists } = await db.supabase.from('game_logs').select('id').like('message', `%txId: ${txId}%`).maybeSingle();
    if (logExists) return res.status(400).json({ success: false, error: '処理済みです' });

    const nonce = Date.now().toString();
    const sig = signMessage(`${adminAddress}:${land.owner_address}:${takeoverPrice}:${nonce}`);
    await fetch(`${KC_SERVER_URL}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: adminAddress, to: land.owner_address, amount: takeoverPrice, nonce, signature: sig, publicKey: adminPublicKeyBase64, nickname: 'take-money', senderName: 'take-money' }) });

    await db.supabase.from('lands').update({ owner_address: address, purchase_price: takeoverPrice }).eq('id', landId);

    await db.supabase.from('game_logs').insert([{ message: `🤝「${user.nickname}」が「${land.name} ${land.coordinate}」を買収しました！ (txId: ${txId})` }]);
    res.json({ success: true, message: `${land.name}を買収しました！` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5.5. 土地レベルアップ
app.post('/api/game/lands/levelup', async (req, res) => {
  const { address, landId, txId } = req.body;
  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: land } = await db.supabase.from('lands').select('*').eq('id', landId).single();

    if (!user || !land) return res.status(404).json({ success: false, error: '見つかりません' });
    if (land.owner_address !== address) return res.status(400).json({ success: false, error: '自分の土地以外はレベルアップできません' });
    if (land.name === '空き地') return res.status(400).json({ success: false, error: '空き地はレベルアップできません' });

    let cost = 0;
    let nextRentRate = 0;
    let levelName = '';

    const type = land.name; 
    const rr = parseFloat(land.rent_rate);
    const bp = parseFloat(land.base_price);

    if (type === '住宅地') {
      if (rr <= 0.015) { cost = bp * 1.5; nextRentRate = 0.035; levelName = 'マンション'; }
      else if (rr <= 0.035) { cost = bp * 3.0; nextRentRate = 0.070; levelName = 'タワーマンション'; }
    } else if (type === '商業地') {
      if (rr <= 0.020) { cost = bp * 2.0; nextRentRate = 0.045; levelName = 'ショッピングモール'; }
      else if (rr <= 0.045) { cost = bp * 4.0; nextRentRate = 0.090; levelName = '巨大テーマパーク'; }
    } else if (type === '工業地') {
      if (rr <= 0.025) { cost = bp * 2.5; nextRentRate = 0.055; levelName = '大規模工場'; }
      else if (rr <= 0.055) { cost = bp * 5.0; nextRentRate = 0.110; levelName = 'ハイテク研究所'; }
    }

    if (cost === 0) return res.status(400).json({ success: false, error: '既に最大レベルです' });

    const txRes = await fetch(`${KC_SERVER_URL}/api/transactions/${adminAddress}`);
    if (!txRes.ok) return res.status(500).json({ success: false, error: 'KCサーバーへの接続エラー' });
    const txData = await txRes.json();
    const tx = txData.transactions.find(t => t.id === txId || t.tx_id === txId);
    if (!tx || tx.to_addr !== adminAddress || tx.from_addr !== address) return res.status(400).json({ success: false, error: '有効な支払いが見つかりません' });
    const amountPaid = parseFloat(tx.amountDisplay || (tx.amount / 1000000));
    if (amountPaid < cost) return res.status(400).json({ success: false, error: '支払額が不足しています' });

    const { data: logExists } = await db.supabase.from('game_logs').select('id').like('message', `%txId: ${txId}%`).maybeSingle();
    if (logExists) return res.status(400).json({ success: false, error: '処理済みです' });

    const newPurchasePrice = (land.purchase_price ? parseFloat(land.purchase_price) : parseFloat(land.base_price)) + cost;
    await db.supabase.from('lands').update({ rent_rate: nextRentRate, purchase_price: newPurchasePrice }).eq('id', landId);

    await db.supabase.from('game_logs').insert([{ message: `🏢「${user.nickname}」が「${land.name} ${land.coordinate}」を [${levelName}] に改築しました！ (txId: ${txId})` }]);
    res.json({ success: true, message: `${levelName}にレベルアップしました！` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5.6. 土地売却
app.post('/api/game/lands/sell', async (req, res) => {
  const { address, landId } = req.body;
  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: land } = await db.supabase.from('lands').select('*').eq('id', landId).single();

    if (!user || !land) return res.status(404).json({ success: false, error: '見つかりません' });
    if (land.owner_address !== address) return res.status(400).json({ success: false, error: '自分の土地しか売却できません' });

    const currentPrice = land.purchase_price ? parseFloat(land.purchase_price) : parseFloat(land.base_price);
    const sellPrice = currentPrice * 0.8;

    const nonce = Date.now().toString();
    const sig = signMessage(`${adminAddress}:${address}:${sellPrice}:${nonce}`);
    const sendRes = await fetch(`${KC_SERVER_URL}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: adminAddress, to: address, amount: sellPrice, nonce, signature: sig, publicKey: adminPublicKeyBase64, nickname: 'take-money', senderName: 'take-money' }) });
    if (!sendRes.ok) return res.status(400).json({ success: false, error: 'KC送金に失敗しました' });

    await db.supabase.from('lands').update({ owner_address: null, purchase_price: null, name: '空き地', rent_rate: 0 }).eq('id', landId);

    await db.supabase.from('game_logs').insert([{ message: `📉「${user.nickname}」が「${land.name} ${land.coordinate}」を売却し、空き地に戻りました。` }]);
    res.json({ success: true, message: `土地を売却し、${sellPrice} KCを獲得しました！` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 6. 株式一覧取得
app.get('/api/game/stocks', async (req, res) => {
  try {
    const { data: stocks, error: err } = await db.supabase.from('stocks').select('*');
    if (err) throw err;
    const formatted = stocks.map(s => ({
      ...s,
      current_price: parseFloat(s.current_price),
      dividend_yield: parseFloat(s.dividend_yield)
    }));
    res.json({ success: true, stocks: formatted });
  } catch (e) {
    console.error("Stocks Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 7. 株式売買
app.post('/api/game/stocks/trade', async (req, res) => {
  const { address, stockId, quantity, type, txId } = req.body;
  if (!address || !stockId || !quantity || quantity <= 0) return res.status(400).json({ success: false, error: '無効なパラメータです' });

  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: stock } = await db.supabase.from('stocks').select('*').eq('id', stockId).single();
    if (!user || !stock) return res.status(404).json({ success: false, error: 'ユーザーまたは株式が見つかりません' });

    const totalPrice = parseFloat(stock.current_price) * quantity;

    if (type === 'buy') {
      if (!txId) return res.status(400).json({ success: false, error: 'txIdが必要です' });
      const txRes = await fetch(`${KC_SERVER_URL}/api/transactions/${adminAddress}`);
      if (!txRes.ok) return res.status(500).json({ success: false, error: 'KCサーバー接続エラー' });
      const txData = await txRes.json();
      const tx = txData.transactions.find(t => t.id === txId || t.tx_id === txId);
      if (!tx || tx.to_addr !== adminAddress || tx.from_addr !== address) return res.status(400).json({ success: false, error: '有効な支払いが見つかりません' });
      const amountPaid = parseFloat(tx.amountDisplay || (tx.amount / 1000000));
      if (amountPaid < totalPrice) return res.status(400).json({ success: false, error: '支払額が不足しています' });
      
      const { data: logExists } = await db.supabase.from('game_logs').select('id').like('message', `%txId: ${txId}%`).maybeSingle();
      if (logExists) return res.status(400).json({ success: false, error: '処理済みです' });
    } else if (type === 'sell') {
      const { data: hold } = await db.supabase.from('user_stocks').select('quantity').eq('address', address).eq('stock_id', stockId).maybeSingle();
      if (!hold || hold.quantity < quantity) return res.status(400).json({ success: false, error: '保有数が不足しています' });
      
      const nonce = Date.now().toString();
      const sig = signMessage(`${adminAddress}:${address}:${totalPrice}:${nonce}`);
      const sendRes = await fetch(`${KC_SERVER_URL}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: adminAddress, to: address, amount: totalPrice, nonce, signature: sig, publicKey: adminPublicKeyBase64, nickname: 'take-money', senderName: 'take-money' }) });
      if (!sendRes.ok) return res.status(400).json({ success: false, error: 'KC送金に失敗しました' });
    } else {
      return res.status(400).json({ success: false, error: '無効な取引タイプです' });
    }

    const { data: holding } = await db.supabase.from('user_stocks').select('id, quantity').eq('address', address).eq('stock_id', stockId).maybeSingle();
    let newQuantity = quantity;
    if (holding) {
      newQuantity = type === 'buy' ? holding.quantity + quantity : holding.quantity - quantity;
      if (newQuantity > 0) {
        await db.supabase.from('user_stocks').update({ quantity: newQuantity }).eq('id', holding.id);
      } else {
        await db.supabase.from('user_stocks').delete().eq('id', holding.id);
      }
    } else if (type === 'buy') {
      await db.supabase.from('user_stocks').insert([{ address, stock_id: stockId, quantity }]);
    }

    const actionText = type === 'buy' ? '購入' : '売却';
    await db.supabase.from('game_logs').insert([{ message: `📈「${user.nickname}」が${stock.company_name}株を ${quantity}株 ${actionText}しました` }]);

    res.json({ success: true, message: `${stock.company_name}株を${quantity}株${actionText}しました！` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 8. ログ取得
app.get('/api/game/logs', async (req, res) => {
  try {
    const { data: logs, error: err } = await db.supabase
      .from('game_logs')
      .select('*')
      .order('id', { ascending: false })
      .limit(30);

    if (err) throw err;
    res.json({ success: true, logs });
  } catch (e) {
    console.error("Logs Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- シミュレーション処理 (Supabase版) ---
// --- シミュレーター（サーバーレス対応） ---
app.get('/api/game/simulate', async (req, res) => {
  try {
    const { data: systemClock, error: clockErr } = await db.supabase
      .from('users')
      .select('balance_cash')
      .eq('address', 'SYSTEM_CLOCK')
      .maybeSingle();
      
    if (clockErr) throw clockErr;

    const now = Date.now();
    let lastTime = systemClock ? Number(systemClock.balance_cash) : now;

    const elapsedMs = now - lastTime;
    const intervalMs = 170000;

    if (elapsedMs < intervalMs && systemClock) {
      return res.json({ success: true, message: "Cooldown active" });
    }

    let elapsedSteps = Math.floor(elapsedMs / intervalMs);
    if (!systemClock) {
      elapsedSteps = 1;
      lastTime = now;
    }
    if (elapsedSteps > 1000) {
      elapsedSteps = 1000; // Cap at ~47 hours
    }
    if (elapsedSteps <= 0) elapsedSteps = 1;

    const newClock = systemClock ? lastTime + (elapsedSteps * intervalMs) : now;
    await db.supabase.from('users').upsert([
      { address: 'SYSTEM_CLOCK', public_key: 'SYSTEM_CLOCK', nickname: 'SYSTEM_CLOCK', balance_cash: newClock }
    ], { onConflict: 'address' });

    // 1. Stocks
    const { data: stocks } = await db.supabase.from('stocks').select('*');
    if (stocks) {
      for (const stock of stocks) {
        let newPrice = parseFloat(stock.current_price);
        for(let i=0; i<elapsedSteps; i++) {
          const changePercent = (Math.random() * 0.2) - 0.1;
          newPrice = newPrice * (1 + changePercent);
        }
        newPrice = Math.max(10, Math.round(newPrice * 100) / 100);
        await db.supabase.from('stocks').update({ current_price: newPrice }).eq('id', stock.id);
      }
    }

    // 2. Lands
    const { data: lands } = await db.supabase.from('lands').select('*');
    if (lands) {
      for (const land of lands) {
        let newPrice = parseFloat(land.base_price);
        for(let i=0; i<elapsedSteps; i++) {
          const changePercent = (Math.random() * 0.08) - 0.03;
          newPrice = newPrice * (1 + changePercent);
        }
        newPrice = Math.max(50, Math.round(newPrice));
        await db.supabase.from('lands').update({ base_price: newPrice }).eq('id', land.id);
      }
    }

    // 3. Rent
    const { data: ownedLands } = await db.supabase.from('lands').select('purchase_price, owner_address, rent_rate').not('owner_address', 'is', null);
    if (ownedLands) {
      for (const land of ownedLands) {
        const rentRate = parseFloat(land.rent_rate);
        if (rentRate > 0) {
          const singleRent = Math.round(parseFloat(land.purchase_price) * rentRate);
          const totalRent = singleRent * elapsedSteps;
          if (totalRent > 0) {
            const nonce = Date.now().toString() + Math.floor(Math.random()*1000);
            const sig = signMessage(`${adminAddress}:${land.owner_address}:${totalRent}:${nonce}`);
            fetch(`${KC_SERVER_URL}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: adminAddress, to: land.owner_address, amount: totalRent, nonce, signature: sig, publicKey: adminPublicKeyBase64, nickname: 'take-money', senderName: 'take-money' }) }).catch(e => console.error(e));
          }
        }
      }
    }

    // 4. Dividends
    const { data: holdings } = await db.supabase.from('user_stocks').select('quantity, address, stock_id').gt('quantity', 0);
    if (holdings && stocks) {
      for (const hold of holdings) {
        const stock = stocks.find(s => s.id === hold.stock_id);
        if (stock) {
          const singleDiv = Math.round(parseFloat(stock.current_price) * hold.quantity * 0.008);
          const totalDiv = singleDiv * elapsedSteps;
          if (totalDiv > 0) {
            const nonce = Date.now().toString() + Math.floor(Math.random()*1000);
            const sig = signMessage(`${adminAddress}:${hold.address}:${totalDiv}:${nonce}`);
            fetch(`${KC_SERVER_URL}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: adminAddress, to: hold.address, amount: totalDiv, nonce, signature: sig, publicKey: adminPublicKeyBase64, nickname: 'take-money', senderName: 'take-money' }) }).catch(e => console.error(e));
          }
        }
      }
    }

    if (Math.random() < 0.5) {
      const events = [
        `📢 経過報告：時間経過に伴い、${elapsedSteps}回分の市場変動・家賃振込が完了しました！`
      ];
      const randomMsg = events[Math.floor(Math.random() * events.length)];
      await db.supabase.from('game_logs').insert([{ message: randomMsg }]);
    }

    res.json({ success: true, message: `Simulation executed (${elapsedSteps} steps)` });
  } catch (e) {
    console.error("Simulation error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 重複送信（Vercelリトライ等）防止用の送金キャッシュ
const sendCache = new Map();

// KC Proxy Routes
app.get('/api/game/kc-proxy/balance/:address', async (req, res) => {
  try {
    const balRes = await fetch(`${KC_SERVER_URL}/api/balance/${req.params.address}?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Pragma': 'no-cache', 'Cache-Control': 'no-cache' }
    });
    if (balRes.status === 404) {
      return res.json({ balance: 0.0, nonce: 0 });
    }
    if (!balRes.ok) return res.status(balRes.status).send(await balRes.text());
    res.json(await balRes.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/game/kc-proxy/send', async (req, res) => {
  const { signature } = req.body;
  
  // 15秒以内の同一署名リクエストはキャッシュから返却 (二重送信防止)
  if (signature && sendCache.has(signature)) {
    console.log(`[Deduplication] Returning cached response for signature: ${signature.slice(0, 10)}...`);
    return res.json(sendCache.get(signature));
  }

  try {
    const sendRes = await fetch(`${KC_SERVER_URL}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    
    if (!sendRes.ok) return res.status(sendRes.status).send(await sendRes.text());
    const data = await sendRes.json();
    
    // 成功したレスポンスを一時的にキャッシュ
    if (signature && data.success) {
      sendCache.set(signature, data);
      setTimeout(() => {
        sendCache.delete(signature);
      }, 15000);
    }
    
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
