// Optional local UI check; uses an installed Chromium browser and a fresh synthetic profile.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [reportFile, browser] = process.argv.slice(2);
assert.ok(reportFile && browser, 'Pass a synthetic index.html and installed Chromium executable.');
const profile = await mkdtemp(path.join(path.dirname(reportFile), 'browser-check-'));
const child = spawn(browser, ['--headless=new', '--no-first-run', '--disable-background-networking',
  '--disable-sync', '--disable-extensions', '--disable-component-update', '--disable-default-apps',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: 'ignore', windowsHide: true });
const exit = once(child, 'exit');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, send;
try {
  let port;
  for (let n = 0; n < 200; n++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(child.exitCode, null, 'Browser exited before becoming ready.');
    await pause(50);
  }
  assert.ok(Number.isInteger(port) && port > 0, 'No owned browser debugging port.');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  const pending = new Map(), exceptions = [], externalRequests = [];
  let sequence = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer); pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    else if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url)) {
      externalRequests.push(message.params.request.url);
    }
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const load = async theme => {
    const loaded = new Promise(resolve => {
      const listener = ({ data }) => {
        if (JSON.parse(data).method === 'Page.loadEventFired') { socket.removeEventListener('message', listener); resolve(); }
      };
      socket.addEventListener('message', listener);
    });
    await send('Page.navigate', { url: `${pathToFileURL(reportFile).href}?scoutTheme=${theme}` });
    await Promise.race([loaded, pause(10000).then(() => { throw new Error('Page load deadline'); })]);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
  };
  await load('light');
  assert.deepEqual(await evaluate(`({
    tabs:document.querySelectorAll('button[role=tab]').length,
    summary:document.getElementById('summary').hidden,
    repeat:document.getElementById('repeat').hidden,
    selected:document.getElementById('summary-tab').getAttribute('aria-selected')
  })`), { tabs: 2, summary: false, repeat: true, selected: 'true' });
  await writeFile(path.join(path.dirname(reportFile), 'preview-light.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate("document.querySelector('svg').closest('.card').scrollIntoView()");
  await writeFile(path.join(path.dirname(reportFile), 'preview-architecture.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate('window.scrollTo(0,0)');
  await evaluate("document.getElementById('repeat-tab').click()");
  assert.equal(await evaluate("document.getElementById('repeat').hidden"), false);
  await writeFile(path.join(path.dirname(reportFile), 'preview-repeat.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Synthetic clipboard denial')}}});
    document.querySelector('[data-copy]').click();`);
  assert.match(await evaluate("document.getElementById('copy-status').textContent"), /copy it manually/);
  assert.match(await evaluate("window.getSelection().toString()"), /mcp-hosting-plan/);
  await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.syntheticCopied=text}}});
    document.querySelector('[data-copy]').click();`);
  assert.match(await evaluate('window.syntheticCopied'), /<DEST_WORKSPACE>/);
  assert.match(await evaluate("document.getElementById('copy-status').textContent"), /Copied/);
  await evaluate("document.getElementById('repeat-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
  assert.equal(await evaluate('document.activeElement.id'), 'summary-tab');
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  assert.notEqual(await evaluate("getComputedStyle(document.getElementById('repeat')).display"), 'none');
  await send('Emulation.setEmulatedMedia', { media: '' });
  await load('dark');
  await writeFile(path.join(path.dirname(reportFile), 'preview-dark.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Page overflow outside its scrollable tables/diagram.');
  assert.deepEqual(exceptions, []);
  assert.deepEqual(externalRequests, []);
  console.log(JSON.stringify({ status: 'passed', tabs: true, keyboard: true, clipboardFallback: true,
    copyText: true, lightAndDark: true, print: true, mobile: true, externalRequests: 0 }));
} finally {
  if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close');
  else if (child.exitCode === null) child.kill();
  socket?.close();
  await Promise.race([exit, pause(10000).then(() => { throw new Error('Owned browser exit unconfirmed; preserve its profile.'); })]);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
