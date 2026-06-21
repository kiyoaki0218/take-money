const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'take_money.db');

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // ユーザーテーブル
  db.run(CREATE TABLE IF NOT EXISTS users (
    address TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    nickname TEXT NOT NULL,
    balance_cash REAL DEFAULT 1000.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ));

  // 土地・不動産テーブル
  db.run(CREATE TABLE IF NOT EXISTS lands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    coordinate TEXT NOT NULL UNIQUE,
    base_price REAL NOT NULL,
    owner_address TEXT,
    purchase_price REAL,
    rent_rate REAL DEFAULT 0.05,
    FOREIGN KEY(owner_address) REFERENCES users(address)
  ));

  // 株式テーブル
  db.run(CREATE TABLE IF NOT EXISTS stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT UNIQUE NOT NULL,
    company_name TEXT NOT NULL,
    current_price REAL NOT NULL,
    dividend_yield REAL DEFAULT 0.03
  ));

  // ユーザー保有株式テーブル
  db.run(CREATE TABLE IF NOT EXISTS user_stocks (
    address TEXT NOT NULL,
    stock_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    PRIMARY KEY(address, stock_id),
    FOREIGN KEY(address) REFERENCES users(address),
    FOREIGN KEY(stock_id) REFERENCES stocks(id)
  ));

  // ゲームログテーブル
  db.run(CREATE TABLE IF NOT EXISTS game_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ));

  // 初期土地データの投入 (16区画, 4x4 グリッド)
  const initialLands = [
    { name: "渋谷スクランブル交差点", coordinate: "0,0", base_price: 500, rent_rate: 0.08 },
    { name: "原宿竹下通り", coordinate: "1,0", base_price: 300, rent_rate: 0.06 },
    { name: "表参道ヒルズ", coordinate: "2,0", base_price: 400, rent_rate: 0.07 },
    { name: "六本木ヒルズ", coordinate: "3,0", base_price: 600, rent_rate: 0.10 },
    { name: "新宿歌舞伎町", coordinate: "0,1", base_price: 450, rent_rate: 0.08 },
    { name: "池袋サンシャイン", coordinate: "1,1", base_price: 350, rent_rate: 0.06 },
    { name: "中目黒桜並木", coordinate: "2,1", base_price: 250, rent_rate: 0.05 },
    { name: "恵比寿ガーデンプレイス", coordinate: "3,1", base_price: 400, rent_rate: 0.07 },
    { name: "秋葉原電気街", coordinate: "0,2", base_price: 380, rent_rate: 0.07 },
    { name: "上野アメ横", coordinate: "1,2", base_price: 200, rent_rate: 0.05 },
    { name: "銀座中央通り", coordinate: "2,2", base_price: 800, rent_rate: 0.12 },
    { name: "築地場外市場", coordinate: "3,2", base_price: 300, rent_rate: 0.06 },
    { name: "品川高輪ゲートウェイ", coordinate: "0,3", base_price: 420, rent_rate: 0.07 },
    { name: "目黒川テラス", coordinate: "1,3", base_price: 220, rent_rate: 0.05 },
    { name: "台場レインボーブリッジ", coordinate: "2,3", base_price: 280, rent_rate: 0.05 },
    { name: "浅草雷門", coordinate: "3,3", base_price: 350, rent_rate: 0.06 }
  ];

  initialLands.forEach(land => {
    db.run(
      INSERT OR IGNORE INTO lands (name, coordinate, base_price, rent_rate) VALUES (?, ?, ?, ?),
      [land.name, land.coordinate, land.base_price, land.rent_rate]
    );
  });

  // 初期株式データの投入
  const initialStocks = [
    { symbol: "APPL", company_name: "アップルパイ社", current_price: 150.0, dividend_yield: 0.03 },
    { symbol: "TSLA", company_name: "テスラコプター社", current_price: 250.0, dividend_yield: 0.01 },
    { symbol: "GOGL", company_name: "ゴーグルメガネ社", current_price: 180.0, dividend_yield: 0.02 },
    { symbol: "AMZN", company_name: "アマゾンジャングル社", current_price: 120.0, dividend_yield: 0.00 },
    { symbol: "MSFT", company_name: "マイクロソフトフット社", current_price: 310.0, dividend_yield: 0.04 }
  ];

  initialStocks.forEach(stock => {
    db.run(
      INSERT OR IGNORE INTO stocks (symbol, company_name, current_price, dividend_yield) VALUES (?, ?, ?, ?),
      [stock.symbol, stock.company_name, stock.current_price, stock.dividend_yield]
    );
  });
});

// ヘルパー関数群（Promiseラッパー）
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = { db, run, get, all };
