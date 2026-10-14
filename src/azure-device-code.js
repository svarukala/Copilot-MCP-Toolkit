const verificationUris = new Set(['https://microsoft.com/devicelogin', 'https://login.microsoft.com/device']);
export function validateAzureDeviceCode(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'userCode,verificationUri'
    || !verificationUris.has(value.verificationUri) || typeof value.userCode !== 'string' || !/^[A-Z0-9]{9}$/.test(value.userCode)) {
    throw Object.assign(new Error('Azure device-code sign-in information was not recognized. No raw sign-in output is displayed.'),
      { code: 'AZURE_DEVICE_CODE_INVALID' });
  }
  return { verificationUri: value.verificationUri, userCode: value.userCode };
}

export function azureDeviceCodeReader(deliver) {
  let pending = '', dropping = false, delivered;
  const line = text => {
    const match = /^(?:WARNING: )?To sign in, use a web browser to open the page (https:\/\/(?:microsoft\.com\/devicelogin|login\.microsoft\.com\/device)) and enter the code ([A-Z0-9]{9}) to authenticate\.$/.exec(text);
    if (!match) {
      if (/^(?:WARNING: )?To sign in,/.test(text)) validateAzureDeviceCode(null);
      return;
    }
    const value = validateAzureDeviceCode({ verificationUri: match[1], userCode: match[2] });
    if (delivered && (delivered.userCode !== value.userCode || delivered.verificationUri !== value.verificationUri)) validateAzureDeviceCode(null);
    if (!delivered) { const snapshot = { ...value }; deliver(value); delivered = snapshot; }
  };
  return {
    push(chunk) {
      for (const part of chunk.toString().split(/(\r?\n)/)) {
        if (part === '\n' || part === '\r\n') {
          if (!dropping) line(pending.replace(/\r$/, ''));
          pending = ''; dropping = false;
        } else if (!dropping) {
          pending += part;
          if (pending.length > 2048) { pending = ''; dropping = true; }
        }
      }
    },
    finish() {
      if (!dropping && pending) line(pending);
      if (!delivered) throw Object.assign(new Error('Azure login did not deliver a recognized device-code prompt. No account is selected; review a fresh login plan.'),
        { code: 'AZURE_DEVICE_CODE_NOT_DELIVERED' });
    },
  };
}
