# Copilot MCP Toolkit

Independent Node.js 22+ ESM package and `copilot-mcp` CLI. Work only in this
repository; the originating Cowork toolkit is not a runtime dependency.

## Continuing work

Read `docs/handoff.md`, `docs/progress-tracker.md` and `docs/wiqd-handoff.md`
before continuing the integration work. Keep the tracker current as work lands.
Distinguish implemented capabilities, historical evidence and proposed work;
the handoff recommendations are not approval for live execution or publication.

## Engineering boundaries

- `npm test` is offline. Use synthetic transports and Azure runners; never
  contact Azure, Microsoft 365 or a provider from tests.
- Generation, identity selection, inspection, deployment, discovery and proof
  are separate reviewed operations. Never infer approval from an earlier phase.
- Keep stdout JSON parseable. Progress and exact approval summaries use stderr.
  Transient device challenges are terminal-only, never durable evidence.
- Require explicit tenant/subscription/account and private Azure authentication.
  Never change a shared Azure CLI account or copy an authentication cache.
  Native Windows SSO is an explicit reviewed user-managed ATK mode, not
  project-isolated credentials; preserve shared caches and disclose login effects.
- API keys are Key Vault references, not argument/config/example secret values.
- Preserve inherited policies, unrelated resources, immutable evidence and locks.
  Failed/inconclusive/unknown dispatched calls remain consumed. No silent retry.
- Preserve historical contract identifiers that participate in hashes or ownership.
  Do not turn historical evidence, restoration or local diagnosis into readiness.
- Only synthetic examples/tests belong in this public repository. Never commit
  generated projects, captures, recovery archives, real identities or raw logs.
- Keep the public API bounded; transport injection is internal test infrastructure.
- No npm publication or live operations are implied by building this package.
