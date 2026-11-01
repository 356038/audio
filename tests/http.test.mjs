import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../backend.mjs';

test('VPS server serves the app, configured endpoint, demo audio and protected API', async () => {
  const server = createServer({FRONTEND_ORIGIN:'https://wave.example',BOT_TOKEN:'123:local-test'});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base+'/');
    assert.equal(page.status,200);
    assert.match(await page.text(),/Музыка вашего профиля Telegram/);
    const config = await (await fetch(base+'/config.js')).text();
    assert.ok(config.includes('https://wave.example'));
    assert.ok(!config.includes('123:local-test'));
    assert.equal((await fetch(base+'/app.js')).status,200);
    const audio = new Uint8Array(await (await fetch(base+'/audio/0.wav')).arrayBuffer());
    assert.equal(new TextDecoder().decode(audio.slice(0,4)),'RIFF');
    const response = await fetch(base+'/api/profile-audios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:''})});
    assert.equal(response.status,401);
    assert.equal((await (await fetch(base+'/health')).json()).configured,true);
    assert.equal((await fetch(base+'/.env')).status,404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
