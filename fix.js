const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const correctProxy = `
// KC Proxy Routes
app.get('/api/game/kc-proxy/balance/:address', async (req, res) => {
  try {
    const balRes = await fetch(\`\${KC_SERVER_URL}/api/balance/\${req.params.address}\`);
    if (!balRes.ok) return res.status(balRes.status).send(await balRes.text());
    res.json(await balRes.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/game/kc-proxy/send', async (req, res) => {
  try {
    const sendRes = await fetch(\`\${KC_SERVER_URL}/api/send\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    if (!sendRes.ok) return res.status(sendRes.status).send(await sendRes.text());
    res.json(await sendRes.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {`;

// Extract everything up to "// KC Proxy Routes"
const match = code.match(/[\s\S]*?(?=\/\/ KC Proxy Routes)/);
if (match) {
  let newCode = match[0] + correctProxy + `\n  console.log(\`Server is running on port \${PORT}\`);\n});\n`;
  fs.writeFileSync('index.js', newCode, 'utf8');
  console.log('Fixed syntax');
} else {
  console.log('Could not find proxy section');
}
