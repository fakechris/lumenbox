import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const state = { chromium: { clicks: 0, text: '' }, electron: { clicks: 0, text: '' } };
const save = () => writeFileSync('/tmp/cua-web-state.json', JSON.stringify(state));
save();
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:17880');
  const kind = url.searchParams.get('client') === 'electron' ? 'electron' : 'chromium';
  if (req.method === 'POST') {
    let value = '';
    for await (const chunk of req) { value += chunk; if (value.length > 10000) { res.writeHead(413).end(); return; } }
    if (url.pathname === '/hit') state[kind].clicks++;
    if (url.pathname === '/value') state[kind].text = value;
    save();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(state[kind]));
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>CUA ${kind} Fixture</title>
    <h1>Local ${kind} fixture</h1>
    <button id="hit">Increment fixture</button>
    <input id="value" aria-label="Fixture value">
    <p id="status">No delivery yet</p>
    <p id="animation"></p>
    <script>
      hit.onclick = async () => {
        const response = await fetch('/hit?client=${kind}', {method:'POST'});
        const state = await response.json();
        document.querySelector('#status').textContent = 'Delivered clicks: ' + state.clicks;
      };
      document.querySelector('#value').oninput = event => fetch('/value?client=${kind}', {method:'POST',body:event.target.value});
      setInterval(() => document.querySelector('#animation').textContent = 'Unrelated tick ' + Date.now(), 300);
    </script>`);
}).listen(17880, '127.0.0.1');
