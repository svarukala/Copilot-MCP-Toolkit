import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { runInNewContext } from 'node:vm';
import { npmProbe, registryProbeTarget, registryContainerCode } from '../src/npm-registry-diagnostic.js';

const answers = [{ address: '93.184.216.34', family: 4 }];
const selection = { kind: 'package-metadata', registryUrl: 'https://packages.example.com/npm/',
  packageName: '@example/mcp-runtime' };
const target = registryProbeTarget(selection);

function hostTransport({ status = 200, errorCode, dns = answers } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    dependencies: {
      lookup: async () => dns,
      request: (url, options, receive) => {
        calls++;
        assert.equal(url.href, target.endpoint);
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.agent, false);
        assert.equal(options.servername, 'packages.example.com');
        assert.deepEqual(options.headers, { Accept: 'application/json' });
        options.lookup(url.hostname, { all: true }, (error, pinned) => {
          assert.equal(error, null); assert.deepEqual(pinned, [answers[0]]);
        });
        const req = new EventEmitter();
        req.end = () => queueMicrotask(() => {
          if (errorCode) req.emit('error', Object.assign(new Error('synthetic-sensitive-error'), { code: errorCode }));
          else {
            const response = Readable.from(['synthetic-response-not-to-retain']);
            response.statusCode = status; response.headers = { 'content-type': 'application/json' };
            receive(response);
          }
        });
        return req;
      },
    },
  };
}

test('registry targets preserve the explicit feed path and scoped package encoding without changing the default', () => {
  assert.equal(registryProbeTarget().endpoint, 'https://registry.npmjs.org/-/ping');
  assert.equal(target.endpoint, 'https://packages.example.com/npm/%40example%2Fmcp-runtime');
  assert.equal(registryProbeTarget({ kind: 'ping', registryUrl: selection.registryUrl }).endpoint,
    'https://packages.example.com/npm/-/ping');
  for (const registryUrl of ['http://packages.example.com/', 'https://operator:secret@packages.example.com/',
    'https://packages.example.com/?secret=x', 'https://packages.example.com/#secret',
    'https://packages.example.com/npm', 'https://127.0.0.1/', 'https://metadata.example.com/',
    'https://packages.internal/', 'https://packages.example.com:444/', 'https://packages.example.com\\npm/']) {
    assert.throws(() => registryProbeTarget({ ...selection, registryUrl }));
  }
});

test('host registry probes issue one credential-free request, reject redirects and do not retain bodies', async () => {
  for (const httpStatus of [200, 204, 301, 401, 403, 404, 500]) {
    const fake = hostTransport({ status: httpStatus });
    const result = await npmProbe(new AbortController().signal, target, fake.dependencies);
    assert.deepEqual(result, { status: httpStatus < 300 ? 'passed' : 'failed', stage: 'http', httpStatus });
    assert.equal(fake.calls, 1);
  }
});

test('host registry probes classify TLS protocol failures and reject private or mixed DNS without dispatch', async () => {
  for (const [errorCode, stage] of [['EPROTO', 'tls'], ['CERT_HAS_EXPIRED', 'tls'], ['ECONNRESET', 'transport']]) {
    const fake = hostTransport({ errorCode });
    assert.deepEqual(await npmProbe(new AbortController().signal, target, fake.dependencies),
      { status: 'failed', stage });
    assert.equal(fake.calls, 1);
  }
  for (const dns of [[], [{ address: '127.0.0.1', family: 4 }], [...answers, { address: '10.0.0.1', family: 4 }]]) {
    const fake = hostTransport({ dns });
    assert.deepEqual(await npmProbe(new AbortController().signal, target, fake.dependencies),
      { status: 'failed', stage: 'network-policy' });
    assert.equal(fake.calls, 0);
  }
  const fake = hostTransport();
  const dnsFailure = { ...fake.dependencies, lookup: async () => { throw new Error('synthetic-dns-detail'); } };
  assert.deepEqual(await npmProbe(new AbortController().signal, target, dnsFailure), { status: 'failed', stage: 'dns' });
  assert.deepEqual(await npmProbe(AbortSignal.abort(), target, fake.dependencies), { status: 'failed', stage: 'cancelled-or-timeout' });
  assert.equal(fake.calls, 0);
});

async function containerTransport({ status = 200, errorCode, dns = answers, dnsError = false } = {}) {
  let calls = 0, resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const modules = {
    'node:net': { isIP },
    'node:dns': { promises: { lookup: async (hostname, options) => {
      assert.equal(hostname, 'packages.example.com');
      assert.equal(options.all, true);
      if (dnsError) throw new Error('synthetic-dns-error');
      return dns;
    } } },
    'node:https': { get: (url, options, receive) => {
      calls++;
      assert.equal(url.href, target.endpoint);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assert.equal(options.servername, 'packages.example.com');
      assert.deepEqual(JSON.parse(JSON.stringify(options.headers)), { Accept: 'application/json' });
      options.lookup(url.hostname, { all: true }, (error, pinned) => {
        assert.equal(error, null); assert.equal(pinned[0], answers[0]);
      });
      const req = new EventEmitter();
      queueMicrotask(() => {
        if (errorCode) req.emit('error', { code: errorCode });
        else receive({ statusCode: status, destroy() {} });
      });
      return req;
    } },
  };
  let timer;
  try {
    const script = registryContainerCode(target);
    assert.ok(!script.includes('registry.npmjs.org'));
    runInNewContext(script, { URL, require: name => {
      assert.ok(Object.hasOwn(modules, name)); return modules[name];
    }, process: { exit: resolveExit }, setTimeout: callback => { timer = setTimeout(callback, 1000); return timer; },
    clearTimeout });
    const code = await exit;
    return { code, calls };
  } finally { clearTimeout(timer); }
}

test('the actual container probe script uses the reviewed target, pins public DNS and fails closed', async () => {
  assert.deepEqual(await containerTransport(), { code: 0, calls: 1 });
  assert.deepEqual(await containerTransport({ status: 302 }), { code: 5, calls: 1 });
  assert.deepEqual(await containerTransport({ status: 404 }), { code: 5, calls: 1 });
  assert.deepEqual(await containerTransport({ errorCode: 'EPROTO' }), { code: 3, calls: 1 });
  assert.deepEqual(await containerTransport({ dns: [...answers, { address: '10.0.0.1', family: 4 }] }), { code: 6, calls: 0 });
  assert.deepEqual(await containerTransport({ dnsError: true }), { code: 2, calls: 0 });
});
