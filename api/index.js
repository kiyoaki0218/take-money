const express = require('express');
const cors = require('cors');
const path = require('path');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const KC_SERVER_URL = process.env.KC_SERVER_URL || 'http://localhost:3000';

app.use(cors());
app.use(express.json());

// 静的ファイルの提供
// app.use(express.static(path.join(__dirname, '..', 'public')));

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
    
    console.log(\n  🎮 Game Admin Wallet Address: \);
    
    // ネイティブ fetch の使用
    const registerRes = await fetch(\/api/register, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: adminPublicKeyBase64,
        inviteCode: 'kurekure2026'
      })
    });
    const regData = await registerRes.json();
    console.log(  🪙 KC Server Register Status:, regData.message || regData.error || 'Registered');
  } catch (e) {
    console.log(  ⚠️ KC Server connection failed. Run Fiction Money server on port 3000 to enable full integration.);
  }
}

// サーバーレス用の遅延初期化ミドルウェア
async function ensureInit(req, res, next) {
  if (!isInitialized) {
    await initAdminWallet();
    isInitialized = true;
  }
  next();
}

app.use('/api/game', ensureInit);

// 署名検証とアドレス導出
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

// --- API エンドポイント ---

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

    await db.supabase.from('game_logs').insert([{ message: 新規プレイヤー「\」が参入しました！ }]);

    res.json({ success: true, user: newUser, message: 'アカウントを新規作成しました（初期資金 1000 Cashを付与）' });
  } catch (e) {
    console.error("API Error:", e);
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
    console.error("API Error:", e);
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

    const formattedLands = lands.map(l => ({
      id: l.id,
      name: l.name,
      coordinate: l.coordinate,
      base_price: parseFloat(l.base_price),
      owner_address: l.owner_address,
      purchase_price: l.purchase_price ? parseFloat(l.purchase_price) : null,
      rent_rate: parseFloat(l.rent_rate),
      owner_name: l.users ? l.users.nickname : null
    }));

    res.json({ success: true, lands: formattedLands });
  } catch (e) {
    console.error("API Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 4. 土地の新規購入
app.post('/api/game/lands/buy', async (req, res) => {
  const { address, landId } = req.body;
  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: land } = await db.supabase.from('lands').select('*').eq('id', landId).single();

    if (!user || !land) {
      return res.status(404).json({ success: false, error: 'ユーザーまたは土地が見つかりません' });
    }
    if (land.owner_address) {
      return res.status(400).json({ success: false, error: 'この土地は既に所有されています。' });
    }
    if (parseFloat(user.balance_cash) < parseFloat(land.base_price)) {
      return res.status(400).json({ success: false, error: '資金が不足しています' });
    }

    const { data: recheck } = await db.supabase.from('lands').select('owner_address').eq('id', landId).single();
    if (recheck.owner_address) {
      return res.status(400).json({ success: false, error: 'タッチの差で土地が購入されました' });
    }

    await db.supabase
      .from('users')
      .update({ balance_cash: parseFloat(user.balance_cash) - parseFloat(land.base_price) })
      .eq('address', address);

    await db.supabase
      .from('lands')
      .update({ owner_address: address, purchase_price: parseFloat(land.base_price) })
      .eq('id', landId);

    const msg = 「\」が「\」を \ Cash で購入しました！;
    await db.supabase.from('game_logs').insert([{ message: msg }]);

    res.json({ success: true, message: '土地の購入が完了しました' });
  } catch (e) {
    console.error("API Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5. 強制買収
app.post('/api/game/lands/takeover', async (req, res) => {
  const { address, landId } = req.body;
  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: land } = await db.supabase.from('lands').select('*').eq('id', landId).single();

    if (!user || !land) {
      return res.status(404).json({ success: false, error: 'ユーザーまたは土地が見つかりません' });
    }
    if (!land.owner_address) {
      return res.status(400).json({ success: false, error: 'この土地は空き地です。通常購入をしてください。' });
    }
    if (land.owner_address === address) {
      return res.status(400).json({ success: false, error: '自分の土地を買収することはできません' });
    }

    const { data: prevOwner } = await db.supabase.from('users').select('*').eq('address', land.owner_address).single();
    const takeoverPrice = parseFloat(land.purchase_price) * 1.5;

    if (parseFloat(user.balance_cash) < takeoverPrice) {
      return res.status(400).json({ success: false, error: 買収資金が不足しています。必要額: \ Cash });
    }

    await db.supabase
      .from('users')
      .update({ balance_cash: parseFloat(user.balance_cash) - takeoverPrice })
      .eq('address', address);

    await db.supabase
      .from('users')
      .update({ balance_cash: parseFloat(prevOwner.balance_cash) + takeoverPrice })
      .eq('address', land.owner_address);

    await db.supabase
      .from('lands')
      .update({ owner_address: address, purchase_price: takeoverPrice })
      .eq('id', landId);

    const msg = 🔥「\」が「\」から「\」を \ Cash で強制買収しました！;
    await db.supabase.from('game_logs').insert([{ message: msg }]);

    res.json({ success: true, message: \を\ Cashで買収しました！ });
  } catch (e) {
    console.error("API Error:", e);
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
    console.error("API Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 7. 株式売買
app.post('/api/game/stocks/trade', async (req, res) => {
  const { address, stockId, type, quantity } = req.body;
  const qty = parseInt(quantity);
  if (!address || !stockId || !type || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ success: false, error: '不正なパラメータです' });
  }

  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    const { data: stock } = await db.supabase.from('stocks').select('*').eq('id', stockId).single();

    if (!user || !stock) {
      return res.status(404).json({ success: false, error: 'ユーザーまたは株式が見つかりません' });
    }

    const totalCost = parseFloat(stock.current_price) * qty;

    if (type === 'buy') {
      if (parseFloat(user.balance_cash) < totalCost) {
        return res.status(400).json({ success: false, error: '資金が不足しています' });
      }

      await db.supabase
        .from('users')
        .update({ balance_cash: parseFloat(user.balance_cash) - totalCost })
        .eq('address', address);

      const { data: existingStock } = await db.supabase
        .from('user_stocks')
        .select('quantity')
        .eq('address', address)
        .eq('stock_id', stockId)
        .maybeSingle();

      if (existingStock) {
        await db.supabase
          .from('user_stocks')
          .update({ quantity: existingStock.quantity + qty })
          .eq('address', address)
          .eq('stock_id', stockId);
      } else {
        await db.supabase
          .from('user_stocks')
          .insert([{ address, stock_id: stockId, quantity: qty }]);
      }

      await db.supabase.from('game_logs').insert([{
        message: 📈「\」が「\」の株を \ 株 (\ Cash) 購入しました
      }]);

    } else if (type === 'sell') {
      const { data: existingStock } = await db.supabase
        .from('user_stocks')
        .select('quantity')
        .eq('address', address)
        .eq('stock_id', stockId)
        .maybeSingle();

      if (!existingStock || existingStock.quantity < qty) {
        return res.status(400).json({ success: false, error: '保有株数が不足しています' });
      }

      await db.supabase
        .from('users')
        .update({ balance_cash: parseFloat(user.balance_cash) + totalCost })
        .eq('address', address);

      await db.supabase
        .from('user_stocks')
        .update({ quantity: existingStock.quantity - qty })
        .eq('address', address)
        .eq('stock_id', stockId);

      await db.supabase.from('game_logs').insert([{
        message: 📉「\」が「\」の株を \ 株 (\ Cash) 売却しました
      }]);
    }

    res.json({ success: true, message: '株式取引が完了しました' });
  } catch (e) {
    console.error("API Error:", e);
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
    console.error("API Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 9. デポジット
app.post('/api/game/deposit', async (req, res) => {
  const { address, txId } = req.body;
  if (!address || !txId) {
    return res.status(400).json({ success: false, error: 'アドレスと取引ID (txId) が必要です' });
  }

  try {
    const txRes = await fetch(\/api/transactions/\);
    if (!txRes.ok) {
      return res.status(400).json({ success: false, error: 'KC取引履歴の取得に失敗しました' });
    }
    const txData = await txRes.json();
    
    const tx = txData.transactions.find(t => t.tx_id === txId);
    if (!tx) {
      return res.status(400).json({ success: false, error: '該当する取引が見つかりません。' });
    }
    
    if (tx.to_addr !== adminAddress) {
      return res.status(400).json({ success: false, error: '送金先が運営ウォレットではありません' });
    }

    const amount = parseFloat(tx.amountDisplay);

    const { data: logExists } = await db.supabase
      .from('game_logs')
      .select('id')
      .like('message', %txId: \%)
      .maybeSingle();

    if (logExists) {
      return res.status(400).json({ success: false, error: 'この取引は既に反映されています' });
    }

    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();

    await db.supabase
      .from('users')
      .update({ balance_cash: parseFloat(user.balance_cash) + amount })
      .eq('address', address);

    await db.supabase.from('game_logs').insert([{
      message: 💰「\」が \ KC をゲーム内にデポジットしました！ (txId: \)
    }]);

    res.json({ success: true, amount, message: \ KC をデポジット反映しました });
  } catch (e) {
    console.error("API Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 10. 出金
app.post('/api/game/withdraw', async (req, res) => {
  const { address, amount } = req.body;
  const withdrawAmount = parseFloat(amount);
  if (!address || isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ success: false, error: '無効なパラメータです' });
  }

  try {
    const { data: user } = await db.supabase.from('users').select('*').eq('address', address).single();
    if (!user) {
      return res.status(404).json({ success: false, error: 'ユーザーが見つかりません' });
    }
    if (parseFloat(user.balance_cash) < withdrawAmount) {
      return res.status(400).json({ success: false, error: '残高が不足しています' });
    }

    const balRes = await fetch(\/api/balance/\);
    if (!balRes.ok) {
      return res.status(500).json({ success: false, error: 'KCサーバーへの接続に失敗しました' });
    }
    const balData = await balRes.json();
    const nonce = balData.nonce;

    const message = \:\:\:\;
    const signature = signMessage(message);

    const sendRes = await fetch(\/api/send, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: adminAddress,
        to: address,
        amount: withdrawAmount,
        nonce: nonce,
        signature: signature,
        publicKey: adminPublicKeyBase64
      })
    });

    const sendData = await sendRes.json();
    if (!sendData.success) {
      return res.status(400).json({ success: false, error: KCサーバー送金失敗: \ });
    }

    await db.supabase
      .from('users')
      .update({ balance_cash: parseFloat(user.balance_cash) - withdrawAmount })
      .eq('address', address);

    await db.supabase.from('game_logs').insert([{
      message: 💸「\」が \ KC をウォレットへ出金しました。
    }]);

    res.json({ success: true, amount: withdrawAmount, message: '出金が完了しました！' });
  } catch (e) {
    console.error("API Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- シミュレーション処理 (Supabase版) ---
function startSimulators() {
  setInterval(async () => {
    try {
      const { data: stocks } = await db.supabase.from('stocks').select('*');
      if (stocks) {
        for (const stock of stocks) {
          const changePercent = (Math.random() * 0.2) - 0.1;
          let newPrice = parseFloat(stock.current_price) * (1 + changePercent);
          newPrice = Math.max(10, Math.round(newPrice * 100) / 100);
          await db.supabase.from('stocks').update({ current_price: newPrice }).eq('id', stock.id);
        }
      }

      const { data: lands } = await db.supabase.from('lands').select('*');
      if (lands) {
        for (const land of lands) {
          const changePercent = (Math.random() * 0.08) - 0.03;
          let newPrice = parseFloat(land.base_price) * (1 + changePercent);
          newPrice = Math.max(50, Math.round(newPrice));
          await db.supabase.from('lands').update({ base_price: newPrice }).eq('id', land.id);
        }
      }

      const { data: ownedLands } = await db.supabase.from('lands').select('purchase_price, owner_address').not('owner_address', 'is', null);
      if (ownedLands) {
        for (const land of ownedLands) {
          const rentIncome = Math.round(parseFloat(land.purchase_price) * 0.015);
          if (rentIncome > 0) {
            const { data: user } = await db.supabase.from('users').select('balance_cash').eq('address', land.owner_address).single();
            if (user) {
              await db.supabase.from('users').update({ balance_cash: parseFloat(user.balance_cash) + rentIncome }).eq('address', land.owner_address);
            }
          }
        }
      }

      const { data: holdings } = await db.supabase.from('user_stocks').select('quantity, address, stock_id').gt('quantity', 0);
      if (holdings && stocks) {
        for (const hold of holdings) {
          const stock = stocks.find(s => s.id === hold.stock_id);
          if (stock) {
            const divIncome = Math.round(parseFloat(stock.current_price) * hold.quantity * 0.008);
            if (divIncome > 0) {
              const { data: user } = await db.supabase.from('users').select('balance_cash').eq('address', hold.address).single();
              if (user) {
                await db.supabase.from('users').update({ balance_cash: parseFloat(user.balance_cash) + divIncome }).eq('address', hold.address);
              }
            }
          }
        }
      }

      if (Math.random() < 0.2) {
        const events = [
          "📢 地価急騰ニュース：銀座エリアのインフラ整備が決定し、周辺の地価が上昇傾向です！",
          "📢 株式ニュース：アップルパイ社が新作アップルタルトを発表し、株価に好影響を与えています。",
          "📢 不動産市況：全体の不動産家賃収入が活性化しています！",
          "📢 テスラコプター社：新モデル of ヘリコプターが航空法に適合し、市場の期待が高まっています。"
        ];
        const randomMsg = events[Math.floor(Math.random() * events.length)];
        await db.supabase.from('game_logs').insert([{ message: randomMsg }]);
      }

    } catch (e) {
      console.error("Simulation error:", e);
    }
  }, 30000);
}

// サーバーレス関数環境以外（ローカルテストなど）で直接実行された場合のみ listen
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(\n  🎮 Take Money ゲームサーバー準備完了 (Port: \));
    await initAdminWallet();
    startSimulators();
  });
}

module.exports = app;
