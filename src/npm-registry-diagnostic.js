import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { normalizeAnonymousEndpoint, requireMetadata } from './anonymous-metadata.js';
import { isPublicAddress, publicHttpsTransport } from './anonymous-network.js';

const registryUrl = { type: 'string', format: 'uri', maxLength: 2048 };
export const registryProbeSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'registryUrl'],
    properties: { kind: { const: 'ping' }, registryUrl } },
  { type: 'object', additionalProperties: false, required: ['kind', 'registryUrl', 'packageName'],
    properties: { kind: { const: 'package-metadata' }, registryUrl,
      packageName: { type: 'string', maxLength: 214,
        pattern: '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$' } } },
] };

export function registryProbeTarget(input = { kind: 'ping', registryUrl: 'https://registry.npmjs.org/' }) {
  const registryUrl = normalizeAnonymousEndpoint(input.registryUrl);
  requireMetadata(new URL(registryUrl).pathname.endsWith('/')
    && ['ping', 'package-metadata'].includes(input.kind), 'INVALID_CONFIG');
  const relative = input.kind === 'ping' ? '-/ping' : encodeURIComponent(input.packageName);
  return { ...input, registryUrl, endpoint: new URL(relative, registryUrl).href };
}

export async function npmProbe(signal, target, dependencies = {}) {
  let stage = 'dns';
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const transport = publicHttpsTransport({ allowErrorStatus: true,
    requestPolicy: endpoint => { requireMetadata(endpoint === target.endpoint, 'NETWORK_BLOCKED'); return new URL(endpoint); },
    lookupImpl: async (...args) => { const result = await (dependencies.lookup ?? lookup)(...args); stage = 'network-policy'; return result; },
    requestImpl: (...args) => {
      stage = 'tls';
      const req = (dependencies.request ?? request)(...args);
      req.on('error', error => {
        stage = error.code === 'EPROTO' || /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '') ? 'tls' : 'transport';
      });
      return req;
    } });
  try {
    const response = await transport(target.endpoint, { method: 'GET', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: probeSignal });
    stage = 'http';
    await response.body?.cancel();
    return { status: response.ok ? 'passed' : 'failed', stage: 'http', httpStatus: response.status };
  } catch (error) {
    return { status: 'failed', stage: probeSignal.aborted ? 'cancelled-or-timeout' : error.httpStatus ? 'http' : stage,
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) };
  }
}

export function registryContainerCode(target) {
  return `const https=require('node:https');
const {lookup}=require('node:dns').promises;
const {isIP}=require('node:net');
const isPublicAddress=${isPublicAddress.toString()};
const endpoint=new URL(${JSON.stringify(target.endpoint)});
const timer=setTimeout(()=>process.exit(4),10000);
lookup(endpoint.hostname,{all:true,verbatim:true}).then(answers=>{
  if(!Array.isArray(answers)||!answers.length||!answers.every(a=>isPublicAddress(a.address)&&a.family===isIP(a.address))){
    clearTimeout(timer);process.exit(6);return;
  }
  const pinned=answers[0];
  const req=https.get(endpoint,{rejectUnauthorized:true,agent:false,servername:endpoint.hostname,
    headers:{Accept:'application/json'},lookup:(_host,options,callback)=>{
      if(options?.all)callback(null,[pinned]);else callback(null,pinned.address,pinned.family);
    }},res=>{
      const code=res.statusCode>=200&&res.statusCode<300?0:5;res.destroy();clearTimeout(timer);process.exit(code);
    });
  req.on('error',e=>{clearTimeout(timer);process.exit(e.code==='EPROTO'||/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code||'')?3:1);});
}).catch(()=>{clearTimeout(timer);process.exit(2);});`;
}
