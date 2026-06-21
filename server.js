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
app.use(express.static(path.join(__dirname, 'public')));

// --- 運営ウォレットの設定 ---
// サーバー起動時にゲーム運営用の鍵ペアを生成し、KCサーバーに自動登録する
let adminKeyPair = null;
let adminAddress = '';
let adminPublicKeyBase64 = '';

async function initAdminWallet() {
  try {
    // 運営用の固定シード（デモ用）またはランダム生成
    // ここではデモ用として毎回同じ鍵ペアになるようにシードを固定
    const seed = new Uint8Array(32);
    seed.fill(7); // ダミーシード
    const keyPair = nacl.sign.keyPair.fromSeed(seed);
    adminKeyPair = keyPair;
    
    adminPublicKeyBase64 = naclUtil.encodeBase64(keyPair.publicKey);
    
    // アドレスの導出
    const crypto = require('crypto');
    const pubBytes = Buffer.from(adminPublicKeyBase64, 'base64');
    adminAddress = crypto.createHash('sha256').update(pubBytes).digest('hex').slice(0, 40);
    
    console.log(\n  🎮 Game Admin Wallet Address: \);
    
    // KCサーバーへの自動登録試行
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
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

// 署名の検証用
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

// アドレスの導出用
function addressFromPublicKey(publicKeyBase64) {
  const crypto = require('crypto');
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  return crypto.createHash('sha256').update(pubBytes).digest('hex').slice(0, 40);
}

// 運営署名作成用ヘルパー
function signMessage(message) {
  const msgBytes = naclUtil.decodeUTF8(message);
  const signatureBytes = nacl.sign.detached(msgBytes, adminKeyPair.secretKey);
  return naclUtil.encodeBase64(signatureBytes);
}

// --- API エンドポイント ---

// 1. ユーザー登録 / ログイン
app.post('/api/game/register', async (req, res) => {
  const { publicKey, nickname } = req.body;
  if (!publicKey || !nickname) {
    return res.status(400).json({ success: false, error: '公開鍵とニックネームが必要です' });
  }

  const address = addressFromPublicKey(publicKey);
  try {
    const existing = await db.get(SELECT * FROM users WHERE address = ?, [address]);
    if (existing) {
      // 既存ユーザーはログイン扱い
      return res.json({ success: true, user: existing, message: 'ログインしました' });
    }

    // 新規登録
    await db.run(
      INSERT INTO users (address, public_key, nickname, balance_cash) VALUES (?, ?, ?, ?),
      [address, publicKey, nickname, 1000.0] // 初期資金 1000 Cash
    );
    const newUser = await db.get(SELECT * FROM users WHERE address = ?, [address]);
    
    // ログ記録
    await db.run(INSERT INTO game_logs (message) VALUES (?), [新規プレイヤー「\」が参入しました！]);

    res.json({ success: true, user: newUser, message: 'アカウントを新規作成しました（初期資金 1000 Cashを付与）' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 2. ユーザーステータス取得
app.get('/api/game/status/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const user = await db.get(SELECT * FROM users WHERE address = ?, [address]);
    if (!user) {
      return res.status(404).json({ success: false, error: 'ユーザーが見つかりません' });
    }

    // 保有土地
    const lands = await db.all(SELECT * FROM lands WHERE owner_address = ?, [address]);
    // 保有株式
    const stocks = await db.all(
      SELECT s.*, us.quantity FROM user_stocks us JOIN stocks s ON us.stock_id = s.id WHERE us.address = ? AND us.quantity > 0,
      [address]
    );

    res.json({ success: true, user, lands, stocks });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 3. 土地一覧取得
app.get('/api/game/lands', async (req, res) => {
  try {
    const lands = await db.all(
      SELECT l.*, u.nickname as owner_name 
      FROM lands l 
      LEFT JOIN users u ON l.owner_address = u.address
    );
    res.json({ success: true, lands });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 4. 土地の新規購入 (空き地)
app.post('/api/game/lands/buy', async (req, res) => {
  const { address, landId } = req.body;
  try {
    const user = await db.get(SELECT * FROM users WHERE address = ?, [address]);
    const land = await db.get(SELECT * FROM lands WHERE id = ?, [landId]);

    if (!user || !land) {
      return res.status(404).json({ success: false, error: 'ユーザーまたは土地が見つかりません' });
    }
    if (land.owner_address) {
      return res.status(400).json({ success: false, error: 'この土地は既に所有されています。買収を試みてください。' });
    }
    if (user.balance_cash < land.base_price) {
      return res.status(400).json({ success: false, error: '資金が不足しています' });
    }

    // トランザクション処理
    await db.run('BEGIN TRANSACTION');
    // 再度土地が空いているか確認（ダブルクリック競合防止）
    const recheck = await db.get(SELECT owner_address FROM lands WHERE id = ?, [landId]);
    if (recheck.owner_address) {
      await db.run('ROLLBACK');
      return res.status(400).json({ success: false, error: 'タッチの差で土地が購入されました' });
    }

    // 残高減額
    await db.run(UPDATE users SET balance_cash = balance_cash - ? WHERE address = ?, [land.base_price, address]);
    // 土地所有権更新
    await db.run(
      UPDATE lands SET owner_address = ?, purchase_price = ? WHERE id = ?,
      [address, land.base_price, landId]
    );

    // ログ
    const msg = 「\」が「\」を \ Cash で購入しました！;
    await db.run(INSERT INTO game_logs (message) VALUES (?), [msg]);

    await db.run('COMMIT');

    res.json({ success: true, message: '土地の購入が完了しました' });
  } catch (e) {
    await db.run('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5. 敵対的買収 (他ユーザーの土地を1.5倍価格で強奪)
app.post('/api/game/lands/takeover', async (req, res) => {
  const { address, landId } = req.body;
  try {
    const user = await db.get(SELECT * FROM users WHERE address = ?, [address]);
    const land = await db.get(SELECT * FROM lands WHERE id = ?, [landId]);

    if (!user || !land) {
      return res.status(404).json({ success: false, error: 'ユーザーまたは土地が見つかりません' });
    }
    if (!land.owner_address) {
      return res.status(400).json({ success: false, error: 'この土地は空き地です。通常購入をしてください。' });
    }
    if (land.owner_address === address) {
      return res.status(400).json({ success: false, error: '自分の土地を買収することはできません' });
    }

    const prevOwner = await db.get(SELECT * FROM users WHERE address = ?, [land.owner_address]);
    const takeoverPrice = land.purchase_price * 1.5;

    if (user.balance_cash < takeoverPrice) {
      return res.status(400).json({ success: false, error: 買収資金が不足しています。必要額: \ Cash });
    }

    // トランザクション処理
    await db.run('BEGIN TRANSACTION');

    // 所有者が変わっていないか再確認
    const recheck = await db.get(SELECT owner_address, purchase_price FROM lands WHERE id = ?, [landId]);
    if (recheck.owner_address !== land.owner_address || recheck.purchase_price !== land.purchase_price) {
      await db.run('ROLLBACK');
      return res.status(400).json({ success: false, error: '土地の所有状態が変更されたため、買収に失敗しました' });
    }

    // 買収者の残高減額
    await db.run(UPDATE users SET balance_cash = balance_cash - ? WHERE address = ?, [takeoverPrice, address]);
    // 元所有者への売却金の加算 (キャピタルゲイン発生！)
    await db.run(UPDATE users SET balance_cash = balance_cash + ? WHERE address = ?, [takeoverPrice, land.owner_address]);
    // 所有権移転
    await db.run(
      UPDATE lands SET owner_address = ?, purchase_price = ? WHERE id = ?,
      [address, takeoverPrice, landId]
    );

    // ログ
    const msg = 🔥「\」が「\」から「\」を \ Cash で強制買収しました！;
    await db.run(INSERT INTO game_logs (message) VALUES (?), [msg]);

    await db.run('COMMIT');

    res.json({ success: true, message: \を\ Cashで買収しました！ });
  } catch (e) {
    await db.run('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  }
});

// 6. 株式一覧取得
app.get('/api/game/stocks', async (req, res) => {
  try {
    const stocks = await db.all(SELECT * FROM stocks);
    res.json({ success: true, stocks });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 7. 株式の売買 (BUY / SELL)
app.post('/api/game/stocks/trade', async (req, res) => {
  const { address, stockId, type, quantity } = req.body; // type: 'buy' | 'sell'
  const qty = parseInt(quantity);
  if (!address || !stockId || !type || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ success: false, error: '不正なパラメータです' });
  }

  try {
    const user = await db.get(SELECT * FROM users WHERE address = ?, [address]);
    const stock = await db.get(SELECT * FROM stocks WHERE id = ?, [stockId]);

    if (!user || !stock) {
      return res.status(404).json({ success: false, error: 'ユーザーまたは株式が見つかりません' });
    }

    const totalCost = stock.current_price * qty;

    await db.run('BEGIN TRANSACTION');

    if (type === 'buy') {
      if (user.balance_cash < totalCost) {
        await db.run('ROLLBACK');
        return res.status(400).json({ success: false, error: '資金が不足しています' });
      }

      // 現金引き落とし
      await db.run(UPDATE users SET balance_cash = balance_cash - ? WHERE address = ?, [totalCost, address]);
      // 保有株追加
      await db.run(
        INSERT INTO user_stocks (address, stock_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT(address, stock_id) DO UPDATE SET quantity = quantity + ?,
        [address, stockId, qty, qty]
      );

      // ログ
      const msg = 📈「\thuser.nickname\t」が「\thstock.company_name\t」の株を \thqty\t 株 (\thtotalCost\t Cash) 購入しました;
      // バッククォート置換バグ回避のためフォーマットを整形
      await db.run(INSERT INTO game_logs (message) VALUES (?), [📈「\」が「\」の株を \ 株 (\ Cash) 購入しました]);

    } else if (type === 'sell') {
      const userStock = await db.get(
        SELECT quantity FROM user_stocks WHERE address = ? AND stock_id = ?,
        [address, stockId]
      );
      if (!userStock || userStock.quantity < qty) {
        await db.run('ROLLBACK');
        return res.status(400).json({ success: false, error: '保有株数が不足しています' });
      }

      // 現金追加
      await db.run(UPDATE users SET balance_cash = balance_cash + ? WHERE address = ?, [totalCost, address]);
      // 保有株削減
      await db.run(
        UPDATE user_stocks SET quantity = quantity - ? WHERE address = ? AND stock_id = ?,
        [qty, address, stockId]
      );

      await db.run(INSERT INTO game_logs (message) VALUES (?), [📉「\」が「\」の株を \ 株 (\ Cash) 売却しました]);
    }

    await db.run('COMMIT');
    res.json({ success: true, message: '株式取引が完了しました' });
  } catch (e) {
    await db.run('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  }
});

// 8. ゲームログ取得
app.get('/api/game/logs', async (req, res) => {
  try {
    const logs = await db.all(SELECT * FROM game_logs ORDER BY id DESC LIMIT 30);
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Fiction Money (KC) 連携処理 ---

// 9. ゲームへのデポジット (KC入金)
app.post('/api/game/deposit', async (req, res) => {
  const { address, txId } = req.body;
  if (!address || !txId) {
    return res.status(400).json({ success: false, error: 'アドレスと取引ID (txId) が必要です' });
  }

  try {
    // KCサーバーから取引履歴を取得して検証する
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const txRes = await fetch(\/api/transactions/\);
    if (!txRes.ok) {
      return res.status(400).json({ success: false, error: 'KC取引履歴の取得に失敗しました' });
    }
    const txData = await txRes.json();
    
    // 対象のtxIdを探し、宛先が運営ウォレット（adminAddress）であるか、および金額を確認する
    const tx = txData.transactions.find(t => t.tx_id === txId);
    if (!tx) {
      return res.status(400).json({ success: false, error: '該当する取引が見つかりません。送金が反映されていない可能性があります。' });
    }
    
    if (tx.to_addr !== adminAddress) {
      return res.status(400).json({ success: false, error: '送金先がゲーム運営ウォレットではありません' });
    }

    const amount = parseFloat(tx.amountDisplay);

    // すでにデポジット済みのtxIdかチェック（二重反映防止）
    const logExists = await db.get(SELECT * FROM game_logs WHERE message LIKE ?, [%txId: \%]);
    if (logExists) {
      return res.status(400).json({ success: false, error: 'この取引は既にデポジット反映済みです' });
    }

    // ゲーム内現金残高を増加
    await db.run('BEGIN TRANSACTION');
    await db.run(UPDATE users SET balance_cash = balance_cash + ? WHERE address = ?, [amount, address]);
    const user = await db.get(SELECT nickname FROM users WHERE address = ?, [address]);
    
    await db.run(INSERT INTO game_logs (message) VALUES (?), [
      💰「\」が \ KC をゲーム内にデポジットしました！ (txId: \)
    ]);
    await db.run('COMMIT');

    res.json({ success: true, amount, message: \ KC をデポジット反映しました });
  } catch (e) {
    await db.run('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  }
});

// 10. ゲームからの出金 (KC送金)
app.post('/api/game/withdraw', async (req, res) => {
  const { address, amount } = req.body;
  const withdrawAmount = parseFloat(amount);
  if (!address || isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ success: false, error: '無効なパラメータです' });
  }

  try {
    const user = await db.get(SELECT * FROM users WHERE address = ?, [address]);
    if (!user) {
      return res.status(404).json({ success: false, error: 'ユーザーが見つかりません' });
    }
    if (user.balance_cash < withdrawAmount) {
      return res.status(400).json({ success: false, error: '出金可能な残高が不足しています' });
    }

    // KCサーバー側のnonceを調査
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const balRes = await fetch(\/api/balance/\);
    if (!balRes.ok) {
      return res.status(500).json({ success: false, error: 'KCサーバーへの接続に失敗しました' });
    }
    const balData = await balRes.json();
    const nonce = balData.nonce;

    // 運営からユーザーへの送金用メッセージを作成し署名
    // message = "from:to:amount:nonce"
    const message = \:\:\:\;
    const signature = signMessage(message);

    // KCサーバーへ送金リクエスト
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

    // ゲーム内残高の削減
    await db.run('BEGIN TRANSACTION');
    await db.run(UPDATE users SET balance_cash = balance_cash - ? WHERE address = ?, [withdrawAmount, address]);
    await db.run(INSERT INTO game_logs (message) VALUES (?), [
      💸「\」が \ KC をウォレットへ出金しました。
    ]);
    await db.run('COMMIT');

    res.json({ success: true, amount: withdrawAmount, message: '出金が完了しました！' });
  } catch (e) {
    await db.run('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  }
});


// --- シミュレーションタイマー（株価変動・インカムゲイン自動付与） ---

function startSimulators() {
  // 1. 定期的な株価・地価変動および配当/家賃インカムゲイン配布 (30秒ごと)
  setInterval(async () => {
    try {
      // 株式の現在値を取得してランダムに変動 (-10% 〜 +10%)
      const stocks = await db.all(SELECT * FROM stocks);
      for (const stock of stocks) {
        const changePercent = (Math.random() * 0.2) - 0.1; // -10% 〜 +10%
        let newPrice = stock.current_price * (1 + changePercent);
        newPrice = Math.max(10, Math.round(newPrice * 100) / 100); // 最小価格10
        await db.run(UPDATE stocks SET current_price = ? WHERE id = ?, [newPrice, stock.id]);
      }

      // 土地の基準価格も少し変動 (-3% 〜 +5%)
      const lands = await db.all(SELECT * FROM lands);
      for (const land of lands) {
        const changePercent = (Math.random() * 0.08) - 0.03;
        let newPrice = land.base_price * (1 + changePercent);
        newPrice = Math.max(50, Math.round(newPrice));
        await db.run(UPDATE lands SET base_price = ? WHERE id = ?, [newPrice, land.id]);
      }

      // インカムゲインの自動分配
      // 土地所有者への家賃収入 (購入価格の 1.5% を30秒ごとに自動獲得)
      const ownedLands = await db.all(SELECT * FROM lands WHERE owner_address IS NOT NULL);
      for (const land of ownedLands) {
        const rentIncome = Math.round(land.purchase_price * 0.015);
        if (rentIncome > 0) {
          await db.run(UPDATE users SET balance_cash = balance_cash + ? WHERE address = ?, [rentIncome, land.owner_address]);
          // ログを流すと多すぎるので、配当ログは個別にしないが、まれにランダムニュースとして流す
        }
      }

      // 株式保有者への配当金 (株価の 0.8% を30秒ごとに自動獲得)
      const holdings = await db.all(SELECT * FROM user_stocks WHERE quantity > 0);
      for (const hold of holdings) {
        const stock = stocks.find(s => s.id === hold.stock_id);
        if (stock) {
          const divIncome = Math.round(stock.current_price * hold.quantity * 0.008);
          if (divIncome > 0) {
            await db.run(UPDATE users SET balance_cash = balance_cash + ? WHERE address = ?, [divIncome, hold.address]);
          }
        }
      }

      // ランダムニュースの生成とログ記録 (20%の確率)
      if (Math.random() < 0.2) {
        const events = [
          "📢 地価急騰ニュース：銀座エリアのインフラ整備が決定し、周辺の地価が上昇傾向です！",
          "📢 株式ニュース：アップルパイ社が新作アップルタルトを発表し、株価に好影響を与えています。",
          "📢 不動産市況：全体の不動産家賃収入が活性化しています！",
          "📢 テスラコプター社：新モデルのヘリコプターが航空法に適合し、市場の期待が高まっています。"
        ];
        const randomMsg = events[Math.floor(Math.random() * events.length)];
        await db.run(INSERT INTO game_logs (message) VALUES (?), [randomMsg]);
      }

    } catch (e) {
      console.error("Simulation error:", e);
    }
  }, 30000); // 30秒ごと
}

// サーバー起動
app.listen(PORT, async () => {
  console.log(\n  🎮 Take Money ゲームサーバー準備完了 (Port: \));
  await initAdminWallet();
  startSimulators();
});
