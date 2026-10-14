import { switchAzureAccount } from '../../src/azure-identity.js';

export const mockAzureUser = { name: 'fixture-user@example.com', type: 'user' };
export async function selectMockAzureIdentity(projectDir, target) {
  const selected = { tenantId: target.tenantId, subscriptionId: target.subscriptionId,
    accountName: mockAzureUser.name };
  const run = async () => ({ tenantId: selected.tenantId, id: selected.subscriptionId, user: mockAzureUser });
  await switchAzureAccount(projectDir, selected, { approve: () => true, run });
  return run;
}
