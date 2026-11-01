import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../backend.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('VPS server serves the app, configured endpoint, theme and protected API', async () => {
  const dir=await mkdtemp(join(tmpdir(),'wave-http-'));
  const server = createServer({FRONTEND_ORIGIN:'https://wave.example',BOT_TOKEN:'123:local-test',WAVE_DATA_DIR:dir});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base+'/');
    assert.equal(page.status,200);
    assert.match(await page.text(),/Открыть подборку/);
    const config = await (await fetch(base+'/config.js')).text();
    assert.ok(config.includes('https://wave.example'));
    assert.ok(!config.includes('123:local-test'));
    assert.equal((await fetch(base+'/app.js')).status,200);
    assert.equal((await fetch(base+'/i18n.js')).status,200);
    const css = await fetch(base+'/theme.css');
    assert.equal(css.status,200);
    assert.ok((await css.text()).includes('halloween'));
    assert.equal((await fetch(base+'/audio/0.wav')).status,404);
    const response = await fetch(base+'/api/profile-audios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:''})});
    assert.equal(response.status,401);
    assert.equal((await (await fetch(base+'/health')).json()).configured,true);
    assert.equal((await fetch(base+'/.env')).status,404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
