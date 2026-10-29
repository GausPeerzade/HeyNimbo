# Automatic voice on macOS

Voice is independent of the answer provider. `main/voice/engine.ts` is the single
selection rule: a saved OpenAI API key selects OpenAI ears and mouth; otherwise
available, authorized on-device listening selects built-in Mac ears and mouth.
Anything else is unavailable with a reason. Connection changes close the old turn
and reconnect both adapters. There is no engine picker or separate voice key.
The existing OpenAI speaking-voice preference applies only to OpenAI; mute applies
to both engines and drawing sounds.

## Native API and privacy

The addon uses **SFSpeechRecognizer**, through objc2's Speech framework bindings,
with `SFSpeechAudioBufferRecognitionRequest`. This API accepts our existing PCM
stream directly and has mature Objective-C bindings. SpeechAnalyzer / Transcriber
would add Swift concurrency and asset-lifecycle bridging to this Rust addon; this
implementation deliberately avoids a large Swift shim.

`SpeechSession(locale?)` starts a task; `append(Buffer)` accepts capture PCM16
(signed, little-endian, mono, 24 kHz), `finish()` ends audio and resolves final
text, and `cancel()` releases the task and wakes a pending finish. Partial results
are enabled and retained while waiting for a final result. The native finish has
a 15-second timeout. A new task is made for each hold; no extra microphone or
AVAudioEngine is opened. Odd-byte chunk boundaries are preserved; an incomplete
last sample is an error. Conversion produces a mono float AVAudioPCMBuffer at the
same sample rate without resampling or dropping samples.

The default listening locale is the Mac's current locale. On-device support and
runtime availability are checked before a task starts. Unsupported or uninstalled
on-device language models are **unavailable**, never a server fallback. Every
request requires on-device recognition. Built-in listening sends no audio off the
Mac. Answers and screen context still use the selected answer provider; local
voice does not imply local answers.

Speaking uses `speechSynthesis` in the existing hidden audio renderer. Apple's
NaturalLanguage framework identifies each sentence's language locally. Only local
installed voices are considered, preferring Premium, Enhanced, then default
(quality is read from the voice name/URI because Web Speech exposes no quality
field). Language/region matches win within a quality tier. Unknown languages use
the Mac's default local voice. No local voice produces a visible playback error,
not a network voice fallback. Initial voice enumeration is allowed up to five
seconds; a hung utterance fails after sixty seconds.

Utterance start sends `playbackStarted` and `lineScheduled`; utterance end advances
the sentence queue. `playEnd` drains only after all utterances end, using the same
`playbackDrained` event as PCM. Stop, Clear and reconnect cancel speech immediately
and invalidate late callbacks. Mute cancels current audible speech and advances
drawing/completion events silently rather than leaving a turn stuck.

## Permission safety

Before **any** speech authorization status/request API, native code checks the
running NSBundle's Info.plist for nonempty `NSSpeechRecognitionUsageDescription`
and `NSMicrophoneUsageDescription` strings. Missing strings return unavailable
without touching TCC. The microphone permission helper and Chromium media
permission handlers use the same metadata guard. No speech prompt is requested at
startup or on a key change. Settings → Connection shows **Allow speech recognition**
only when the supported local engine needs authorization; only that user-click
action requests it. Denied/restricted access shows the reason. Microphone capture
is still initiated only by holding Control + Option. External permission changes
may require restarting the app.

Settings → Voice and About now show microphone status separately from the
answer/voice engine. **Allow microphone…** requests first-time macOS access from
that click; opening the Privacy pane alone cannot register an app that has never
requested access. After denial, the action opens the Microphone pane instead of
repeating a prompt macOS will not show. Missing usage metadata has an actionable
build-repair explanation, not a button that silently fails. Permission status
queries share the guarded microphone helper; rendering Settings never asks for
permission or starts recording.

Packaged apps receive both honest usage descriptions from electron-builder's
`mac.extendInfo` in `apps/desktop/package.json`. OpenAI audio is explicitly disclosed
in the microphone copy. The built-in speech description promises on-device audio
processing, which is enforced rather than silently falling back to Apple's servers.

`pnpm dev` prepares this checkout's permission metadata automatically before
launching the development app. For a direct `electron .` launch after installing
or replacing Electron in **this checkout**, prepare it explicitly first:

```sh
pnpm dev:speech-permissions
```

`scripts/prepare-dev-speech-permissions.cjs` patches only the resolved Electron.app
inside this checkout's node_modules. It refuses an Electron dependency outside the
checkout, creates `Info.plist.before-nimbo-speech` once before editing, and sets both
strings idempotently. It opens no windows, accesses no microphone, and requests no
permission. Restart Electron after patching. Reinstalling Electron replaces the
patch; rerun the script. Restore the backup or reinstall Electron to undo it.
If Electron's download is missing, run its `install.js` in this checkout first.
Quit this checkout's running Electron before repairing its bundle, then restart
it. Do not launch development or packaged apps for validation without approval
for any windows, prompts or microphone use.

## Validation

No-network Vitest tests mock the native module and exercise engine precedence,
missing-usage/denied states, explicit authorization, key-change reconnect, PCM
append/finish order, cancellation/replacement races, empty results, sentence line
mapping, local voice selection, utterance ordering, voice discovery, mute, late
events and timeout cleanup. AudioWindow tests ensure missing usage metadata denies
Chromium capture and never calls microphone authorization APIs. Rust tests cover
PCM sample format/rate/channel layout and arbitrary chunk boundaries, plus the
usage-string guard with a panic-on-access authorization double.

Fourteen targeted behavioral mutations were individually applied, asserted to
fail tests, and restored: OpenAI precedence; authorization gating; PCM forwarding;
turn generation; sentence line identity; late utterance callbacks; mute; local-only
voices; early playback drain; microphone metadata guard; reconnect engine change;
both-required usage strings; PCM endianness; PCM sample rate. All fourteen were
killed by assertions, not compile/import failures. Logs are generated under
`apps/desktop/out/speech-validation/` (ignored build output).

Final checks: `pnpm test` passed 351 Vitest tests and 24 Rust tests;
`pnpm typecheck`, `pnpm build` (including the release native addon),
`cargo test --workspace`, clippy with `-D warnings`, and `git diff --check` passed.
The dev permission patch was run twice; the original backup checksum was unchanged.
One earlier unrelated model-fuzz run exceeded its five-second timeout; its isolated
rerun and the final full suite passed without changing that test.

### Optional offline fixture (approval required)

```sh
NIMBO_DEBUG_LOCAL_SPEECH_CHECK=1 node scripts/check-local-speech.cjs
```

Ask before running: this may show a one-time macOS Speech Recognition prompt. The
opt-in script creates a new empty `/tmp/nimbo-speech-check-*` directory, generates
`The purple notebook is beside the window.` offline with `say -o`, converts it to
24 kHz mono PCM16 with afconvert, and feeds the actual BuiltInEars adapter in this
checkout's Electron. Paths are arguments; interpreters never run inside the temp
directory. It uses an isolated profile, prohibited activation policy, no windows,
no microphone, no credentials, and a deny-all Electron network handler. It asserts
expected transcript words and prints finish-to-final latency. The parent deadline
is sixty seconds including fixture generation; the child also has a hard watchdog.
Do not retry authorization in a loop or kill other checkouts' processes.

Approved check on 2026-10-29: waited sixty seconds before running; installed this
worktree's missing Electron download; patched/backed up only this worktree's
Electron bundle. Authorization returned **authorized**, but Speech reported
`No Assistant asset for language en-US` and `supportsOnDeviceRecognition` was false.
The check correctly stopped as unavailable before creating a recognition task.
**No transcript or finish-to-final latency was obtained.** No retry was performed;
no matching worktree Electron processes remained. The fixture/profile are in
`/tmp/nimbo-speech-check-*`. This is not a successful end-to-end transcription or
an acoustic playback/microphone test.

Limits: recognition languages depend on installed on-device assets and the OS;
macOS speech/dictation language downloads may be needed where available. The app
does not download assets automatically. Recognition accuracy and latency on this
Mac remain unmeasured until an on-device model is available and another check is
approved. Speech quality depends on installed local voices; utterance start/end
preserve drawing beat events, but actual acoustic timing was not measured.
