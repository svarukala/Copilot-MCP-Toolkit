export const unscannedRiskAcknowledgement = 'unscanned-deployment-risk-v1';
export const unscannedRiskSchema = {
  const: unscannedRiskAcknowledgement,
  description: 'Explicitly acknowledge that scanning/SBOM are not run and vulnerable components may be deployed. Not vulnerability qualification.',
};

// Admission for NEW authority only; historical readers must not retrofit it.
export function requireUnscannedRisk(config, scanEnabled = config.scanGate === true) {
  if ((!scanEnabled || config.unscannedRiskAcknowledgement !== undefined)
    && config.unscannedRiskAcknowledgement !== unscannedRiskAcknowledgement) {
    throw Object.assign(new Error(`Scanning remains off by default. Explicitly set unscannedRiskAcknowledgement to "${unscannedRiskAcknowledgement}" before reviewing a new unscanned plan. No scan or SBOM is implied.`),
    { code: 'UNSCANNED_RISK_ACKNOWLEDGEMENT_REQUIRED' });
  }
}

export function unscannedRiskBinding(config) {
  return config.unscannedRiskAcknowledgement === undefined ? {}
    : { unscannedRiskAcknowledgement: config.unscannedRiskAcknowledgement };
}
