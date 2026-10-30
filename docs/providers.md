# Connections, answer models and voice

## What ChatGPT plan tokens may call

The official [cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt),
[quickstart](https://developers.openai.com/siwc/quickstart),
[models and inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
authorize account-specific `GET https://api.openai.com/v1/models` and streaming
`POST https://api.openai.com/v1/responses`. The plan catalog has `models`,
`visibility`, `slug` and `display_name`, not the API-key catalog's `data[].id`.
Only granted `chatgpt.tokens.use.direct` permits inference. An identity-only
connection is retained but cannot answer. Eligible Plus/Pro plans, workspace
policy, region, app limits and available models still apply.

Each plan inference uses `store:false`, `stream:true`, full history in an input
array, and developer instructions. It omits unsupported fields, including
`max_output_tokens`, `previous_response_id`, `temperature` and `truncation`.
Success requires the actual `response.completed` event, not just some text or EOF.
Images are supported if the selected model accepts them. Audio/video input,
Files uploads and the transcription API are explicitly unsupported. Realtime
speech is **not** an authorized route; support for another client or API is not
permission for this flow ([errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)).

Consequently **ChatGPT plan tokens power answers only**. Voice automatically uses
OpenAI realtime when an OpenAI API key is saved, regardless of the answer provider;
otherwise it uses authorized on-device Mac recognition and local system speech.
There is no separate voice-key section or engine setting. If local listening is
unavailable, typed Home questions still work without speech, and Control + Option
shows the reason without opening the microphone. See [voice.md](voice.md) for
permissions, development setup, privacy and local-language availability.

## Sign-in, storage and terms

The [registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[identity verification reference](https://developers.openai.com/siwc/website), and
[accounts/sessions guide](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
are the protocol sources. HeyNimbo generates a stable local UUID host ID,
starts an ephemeral-port `127.0.0.1` listener before opening the system browser,
and uses fresh S256 PKCE, state and nonce for every attempt. The listener is
single-use and expires after three minutes. First registration uses
`dynamic_agent_client` and `agent_name_hint=HeyNimbo`; the callback-issued
client ID is saved before exchange, and reused even after an expired code.
Tokens are never exchanged using the dynamic-registration sentinel.

Discovery and JWKS are restricted to `auth.openai.com`. `jose` verifies the
signature, issuer, issued client audience, expiration and original nonce.
Returning/refresh identities must match their registration. Refreshes are
serialized and rotating tokens/scopes/expiry are replaced together. Terminal
refresh errors delete unusable credentials but retain registration. Sign-out
stops the turn, attempts discovery-advertised refresh-token revocation with a
bounded retry, and clears local access, refresh and ID tokens even when remote
revocation cannot be confirmed. The UI then directs the user to ChatGPT Settings.
Multiple registrations remain separate, with stable labels even if emails match.

Every key and OAuth record lives in one file, `userData/credentials.json`,
written atomically and owner-only (`0600`) inside the owner-only (`0700`) app
data folder. This is the model Pi (`~/.pi/agent/auth.json`), OpenCode
(`auth.json`), Codex's file store (`~/.codex/auth.json`) and Hermes
(`~/.hermes/.env`) use. HeyNimbo does not use the macOS Keychain: an unsigned
or ad-hoc-signed build gets a new code identity on every rebuild, so Keychain
access asked for the login password at every launch. Agent file tools refuse
`credentials.json`/`auth.json` names even inside a granted folder.

Keys saved by older builds (`<name>.bin`, Electron `safeStorage`) are moved
into `credentials.json` on first load with one Keychain read each, then
deleted. The first denied read ends migration permanently: that file and any
not yet read are renamed `<name>.bin.unmigrated` (kept, never read again) and
those keys are re-entered in Settings.
Compatible keys include the normalized full endpoint URL inside the encrypted
credential record. Discovery, pre-save validation and answer requests use a saved
key only when that full endpoint matches; changing host, port or path never
forwards the previous key. Old compatible keys without an endpoint binding are
not reused: enter a key explicitly if the endpoint needs one. Endpoint edits clear
the compatible model and save without contacting the old endpoint. The connection
can stay unselected until Find models succeeds and a new model is chosen, so a
dead endpoint or disjoint catalog cannot prevent repair.
Settings contain only provider/model/endpoint preferences. IPC snapshots contain
only presence, public account display data and model metadata, never saved
credentials or key hints. Key entry is a one-way renderer-to-main operation;
entered keys are cleared after submission. SDK errors are sanitized before logs,
history or IPC.

### Saved connections and the four-character hint decision

Settings → Connection intentionally discloses **only the last four characters**
of a saved API key, computed in main, so the user can identify which key belongs
to each provider without retrieving it. No prefix or additional credential
characters are returned. Keys of four characters or fewer get an empty suffix,
so even a short custom-server key is never disclosed in full. **OAuth access,
refresh and ID tokens never get hints**, including when ChatGPT is signed in.
Custom-endpoint hints are bound to the same normalized full URL as the credential;
another host, port or path gets neither that key nor its hint.

Hints and saved dates travel only in the dedicated `connection/details` response,
not `ConnectionSnapshot`, `AppSnapshot`, broadcasts, history or application logs.
The IPC handler permits this request only from the Settings main frame; Home and
setup cannot retrieve it. The Settings renderer requests and caches hints only
while Connection is open, clears them on navigation away, and rejects stale
responses. They are passed separately to the Connection view, never merged into
app snapshots. Key hints are an explicit, limited disclosure for this local UI,
not a masking of a full key sent to the renderer.

The saved date is the encrypted credential file's last-write time, read in main.
This reads saved files without rewriting their contents or inventing a
provider-side creation date; a restored file can therefore reflect its restored
mtime. A missing timestamp is left unknown. Removing a key deletes its hint and
date from main's cache as well as deleting the encrypted record, after a native
confirmation dialog. Sign out likewise confirms before disconnecting ChatGPT.
Use for answers changes only the selected provider: every provider's saved model
choice, the other credentials and automatic voice routing are preserved.

**Terms review before release:** the full [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
could not be retrieved because OpenAI's page returned a Cloudflare JavaScript
challenge. Implementation proceeded with supervisor-supplied verbatim excerpts
of sections 1, 2 and 4 and Service Terms §15, plus the official technical docs.
The user must review the **full current terms before release**. Implemented
obligations: use our own app name; store tokens only locally under the user's
control; make requests only for that user's activity in HeyNimbo; provide no
general-purpose plan-token proxy; charge nothing for plan use; never pool, sell,
share, rotate accounts to bypass limits, or use one person's plan for another.
There is no background inference, automatic billing fallback, or plan access to
ChatGPT conversations. Manage usage links to `https://chatgpt.com/settings/usage`.

## Answer SDK and models

Answers use Vercel AI SDK `streamText` with explicit provider objects (not the
AI Gateway), zero request/stream retries, native provider parsers and one text-delta
normalization in `main/answer-provider.ts`. Drawing `INSTRUCTIONS` and history
are provider-neutral. SDK raw decoded events only verify terminal completion;
there is no second SSE parser. Anthropic system instructions use ephemeral cache
control. Screenshots become the provider's native image block through the SDK.

Direct packages were verified against registry metadata and installed licenses,
and pinned exactly: `ai` **7.0.156**, `@ai-sdk/openai` **4.0.104**,
`@ai-sdk/anthropic` **4.0.91**, `@ai-sdk/google` **4.0.107**,
`@ai-sdk/deepseek` **3.0.75**, `@ai-sdk/openai-compatible` **3.0.80**, and
`@openrouter/ai-sdk-provider` **3.1.0**: all **Apache-2.0**. `jose` **6.2.14** is
**MIT**. Licenses/notices are included in `THIRD_PARTY_NOTICES.md` and retained
in the unmodified installed dependencies. Transitive MIT notices are included;
`json-schema` 0.4.0 offers AFL-2.1 OR BSD-3-Clause and is used under its
BSD-3-Clause option.

Settings → Connection has independent **Provider**, **Model** and **Thinking**
controls. One answer model and thinking level apply to explanations, 2D and 3D.
Thinking offers Low, Medium, High and Provider default for the known OpenAI and
Anthropic models. Other models keep the provider default; unsupported options
are not sent. Voice synthesis is still chosen automatically and is not a
separate answer model.

| Connection | Default for new settings | Other recommended models |
| --- | --- | --- |
| OpenAI key / ChatGPT | `gpt-6.1-terra`, low | `gpt-6.1-sol` |
| Anthropic | `claude-sonnet-5-5`, low | `claude-haiku-5-5`, `claude-opus-5-5` |
| Google Gemini | `gemini-3.8-flash` | `gemini-3.5-flash-lite`, `gemini-4-argon` |
| DeepSeek | `deepseek-flash` | `deepseek-v4-pro` (text only) |
| OpenRouter | `openai/gpt-6.1-terra` | `google/gemini-3.5-flash-lite`, `anthropic/claude-opus-5.5` |
| Compatible / local | Choose an installed model | Discovered or custom model ID |

Each provider stores a model ID and optional thinking level directly. There is
no preset layer, old-settings migration, former-name alias or legacy setup IPC.
This is an unreleased app: local development data transfers are one-time owner
operations, not runtime compatibility features. Custom IDs have no assumed
thinking level.

OpenAI effort is `reasoning.effort`; Anthropic effort is `output_config.effort`,
not the obsolete manual thinking-budget parameter. Claude's adaptive thinking
stays at the documented default. Gemini and OpenRouter use model-native defaults.
DeepSeek uses documented non-thinking mode for latency; Flash currently supports
vision, Pro does not. Custom IDs have no assumed effort or vision capabilities.

Verification sources:
- [Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) and [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages), [current model IDs](https://platform.claude.com/docs/en/models/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), and [caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- [Gemini models](https://ai.google.dev/gemini-api/docs/models) and [Google SDK options](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai).
- [DeepSeek model IDs](https://api-docs.deepseek.com/), [pricing/capability table (trailing slash)](https://api-docs.deepseek.com/quick_start/pricing/), and [official SDK provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek). `deepseek-flash` now serves V4.1-Flash-1017; legacy V4 Flash names redirect to it.
- OpenRouter's [Terra](https://openrouter.ai/openai/gpt-6.1-terra), [Flash Lite](https://openrouter.ai/google/gemini-3.5-flash-lite), [Opus](https://openrouter.ai/anthropic/claude-opus-5.5) pages, [authentication](https://openrouter.ai/docs/api/reference/authentication) and [authenticated current-key check](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key).
- [AI SDK introduction](https://ai-sdk.dev/docs/introduction), [OpenAI](https://ai-sdk.dev/providers/ai-sdk-providers/openai) and [Anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic) integrations.

Catalogs are fetched using each provider's credential. OpenRouter also calls
`GET /api/v1/key`, because its public model catalog alone cannot validate a key.
Anthropic/Gemini catalogs paginate; OpenRouter metadata describes image inputs.
Compatible connections use `/models`, or Ollama `/api/tags` plus `/api/show`
capabilities. A missing compatible `/models` endpoint allows manual IDs, without
claiming known vision capability. Unknown capabilities default to **text-only**:
no capture, no image input, no screen-coordinate drawing. Text answers and history
still work. Recommendations are not guarantees of model quality. The local
15-request blank-screen evaluations measured Terra, Sonnet and Haiku; the UI's
latency notes identify the measured thinking level and first-3D-part metric.
They are not speech-start guarantees. Other providers, SIWC and higher thinking
levels have not been validated by those evaluations. Catalog entries keep their
existing Experimental/Tested metadata.

Custom base URLs are validated at the settings/IPC boundary: HTTPS only, except
HTTP on exactly `127.0.0.1` or `localhost`; no embedded credentials, query or
fragment. Every provider, catalog and auth fetch rejects redirects rather than
forwarding credentials. Built-in hosts are `api.openai.com`, `auth.openai.com`,
`api.anthropic.com`, `generativelanguage.googleapis.com`, `api.deepseek.com`, and
`openrouter.ai`. Browser actions are fixed to the validated OpenAI authorize URL
or ChatGPT usage settings. Custom hosts are explicitly configured by the user.
Ollama and LM Studio buttons select `http://127.0.0.1:11434/v1` and
`http://127.0.0.1:1234/v1`; hosted Groq/Together or local vLLM use the same adapter.

## History, validation and remaining release checks

History creates schema **v2** directly, including non-null `turns.provider` and
`turns.model`. Reopening current files retains attribution, scenes, context and
FTS; other schema versions are rejected rather than migrated.

Offline tests cover PKCE, authorize query, callback binding/single use/timeout,
claim/signature rejection, exact exchange/refresh/revoke forms, rotation and
expired grants, scope refusal, safeStorage isolation and encrypted credential loading, SDK
request/stream normalization for all providers, terminal/error/interrupted streams,
custom URL validation, model discovery/capability gating, voice gating and history.
All fixtures use synthetic credentials, mocked transports and a mocked callback
server: **no real network calls in tests**.

Run `pnpm test`, `pnpm typecheck` and `pnpm build`. The initial implementation's
one-off mutation checks killed **16/16** deliberate changes: PKCE digest, callback
state, ID-token issuer/audience/nonce/expiry, granted plan permission, loopback
binding, redirect protection, remote HTTP rejection, vision gating, terminal
stream events, encrypted storage, voice gating, billing isolation and turn model
attribution. Each required an actual assertion failure, not a syntax/import error;
sources were restored after each check. The one-off driver is not in the repository.

Follow-up regressions cover full-endpoint credential ownership (including a
same-host path change), explicit key replacement, malformed endpoint bindings, disjoint
catalog switching, unreachable old endpoints, an unselected compatible state,
the unified Model picker/collapsed sections/plain copy, and turn cancellation
aborting stalled OpenAI and Anthropic SDK fetches. The follow-up mutation run was
**blocked before execution by the local command safety filter**, a false positive
on a source expression. It was not retried or worked around, and no mutation was
applied. Those mutation checks were delegated to the supervisor at that handoff.
That follow-up's full gates passed: **264 desktop tests, 20 Rust tests, typecheck
and build**. Tests still use only mocked transports and synthetic credentials.

Saved-connections checks additionally cover the four-character budget, short-key
non-disclosure, no OAuth hints, saved dates, Settings-only delivery, hint cache
clearing/stale responses, model-preserving provider switches, confirmed removal,
all-provider status rows, a clear signed-in ChatGPT state and read-only automatic
voice. **19/19 targeted mutations were killed by assertion failures**: suffix
length, short-key protection, OAuth exclusion, details-only delivery, provider
selection, model preservation, ordinary/custom key removal, Settings/setup IPC
boundaries, removal confirmation, automatic voice, the current-provider marker,
Connection-only requests, stale-response rejection, cache clearing and saved-date
delivery/persistence/rendering (including a known epoch timestamp). Sources were
restored exactly after each check; no mutation driver was added to the repository.
Latest full gates pass: **343 desktop tests
across 49 suites, 20 Rust tests, typecheck and build**.

Hidden, isolated Home/Settings/setup captures for the redesign are in
`/tmp/nimbo-settings-validation/`: every category in light/dark and narrow
windows, plus provider/model/advanced/key-editor states. Settings shares one
sidebar and inset row layout. Connection has no duplicate Your AI summary:
provider, model and thinking live in one aligned group. Saved connections lists
every provider with its status/date and a compact Manage disclosure for connected
accounts. Unconnected providers offer setup; selecting one opens key entry inline.
Advanced retains custom IDs, account switching and (for compatible providers)
endpoint selection. Automatic voice has a read-only summary and the explicit
speech permission action when needed; there is no separate voice key.
Preview blocks all network and uses only synthetic data and never-shown windows,
not desktop captures. These captures do not establish real-provider behavior.

Bundle impact: SDKs remain external main-process dependencies; no SDK is shipped
in renderer bundles. Before changes, main output occupied 124 KiB on disk. The
original provider implementation's main output was 168.45 kB (168 KiB allocated,
reported by `du`), before subsequent merged app work,
plus **27.56 MiB of newly installed uncompressed runtime dependency files**,
including SDK source/docs/maps, peers and jose. This is an installation measurement,
not an assertion about final compressed ASAR/installer size; packaging may omit
unneeded dependency files.

Before release, review the full terms, then explicitly authorize a real test of
sign-in/reauthorization, account eligibility/catalog, refreshed and revoked grants,
and a completed image Responses request. Likewise test the user's chosen API
providers/local servers and evaluate drawing/model quality before labeling any
model Tested. No keys/tokens were read or used during this implementation.
