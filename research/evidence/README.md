# Research evidence

Retrieval date: October 29, 2026. These files document research; they are not shipped application dependencies.

## Retained audit material

- `clicky-audit-sources.json`, `clicky-verification.json`: cited primary-source identities, retrieval and report checks.
- `execution-sources.json`, `execution-citation-ledger.json`: protocol/browser/sandbox/skills/memory references with short verified excerpts, timestamps and content hashes.
- `harness-sources.json`, `harness-link-audit.json`, `harness-citations.json`: fetched harness source/docs, pinned revisions, hashes, recovery paths and report-link audit.
- `harness-ai-probe.mjs`, `harness-ai-probe-result.json`: no-network checks against the already-installed AI SDK. This uses a deliberately mocked model and variable-counting tools; it is not an external provider/desktop integration test.
- Harness retrieval/audit helpers and request inventories support repeat inspection. Original successful retrievals and failed attempts remain distinguishable.

Run the local SDK probe from the repository root:

```sh
node research/evidence/harness-ai-probe.mjs
```

It requires the repository's installed dependencies and writes its result plus installed-source snapshots locally. It opens no UI, reads no user credential/profile, and makes no model request. The deliberate uncooperative-provider fixture is expected to invoke its unguarded mock effect once; the guarded effect count must remain zero. This demonstrates an enforcement requirement, not a real unauthorized OS effect.

## Bulky local-only snapshots

Downloaded pages, upstream source snapshots/tree inventories, demo videos, captions, frames and incidental tool output are retained in this directory locally but ignored by `.gitignore`. They are **not** intended for vendoring or redistribution with HeyNimbo, and a fresh clone will not contain them.

The original product/harness links and exact source revisions are in the reports; compact manifests retain retrieval provenance and hashes. The full hash/retrieval audit requires these local snapshots or an explicit re-fetch. Live documentation can change, so a re-fetch may correctly fail an old content-hash check. Citation identity checks do not establish semantic truth or software safety.

Some execution report snapshot paths point into the original scratch evidence directory; those are ephemeral retrieval aids, not durable project dependencies. All externally derived claims remain traceable to primary URLs and source metadata in the checked-in-sized audit files.

## Limits

No current Clicky binary was installed or reverse engineered. No Codex/Pi/OpenCode/Hermes engine was integrated into HeyNimbo. Only existing app tests/build checks and the installed-SDK mock probe were executed. Reports distinguish public claims, publisher demos, inspected source and unresolved behavior.
