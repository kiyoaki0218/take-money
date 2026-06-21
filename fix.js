const fs = require('fs');
let content = fs.readFileSync('api/index.js', 'utf8');

content = content.replace("app.use(express.static(path.join(__dirname, '..', 'public')));", "// app.use(express.static(path.join(__dirname, '..', 'public')));");

content = content.replace(/await fetch\(`\/api\/register`/g, "await fetch(`${KC_SERVER_URL}/api/register`");
content = content.replace(/await fetch\(`\/api\/transactions\/[^\`]+`\)/g, "await fetch(`${KC_SERVER_URL}/api/transactions/${adminAddress}`)");
content = content.replace(/await fetch\(`\/api\/balance\/[^\`]+`\)/g, "await fetch(`${KC_SERVER_URL}/api/balance/${address}`)");
content = content.replace(/await fetch\(`\/api\/send`/g, "await fetch(`${KC_SERVER_URL}/api/send`");

content = content.replace(/res\.status\(500\)\.json\(\{ success: false, error: e\.message \}\);/g, 'console.error("API Error:", e);\n    res.status(500).json({ success: false, error: e.message });');

fs.writeFileSync('api/index.js', content);
console.log("Replaced successfully");
