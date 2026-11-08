# Voice input

Dictate into the composer instead of typing. The transcript lands in your draft
for review, and only sending the message sends anything to an agent. Dictation
also works in citation comments, diff and file annotations, pull request
comments, replies, and review summaries, and in the desktop app's browser
annotation editor.

On iPhone and Android, voice input transcribes on the device by default. To opt in
to a named environment on that phone, open **Settings → Voice → Transcribe on**. See
[Voice input on mobile](./composer.md#voice-input-on-mobile).

## Choose where audio goes

On web and desktop, you choose where transcription runs.
Nothing is sent until you choose one: open **Settings → Voice** and set
**Transcribe with** to the environment that should transcribe for you.
On a new device, the microphone or dictation shortcut opens that setting from the composer.
Microphone audio recorded on this device is sent to that environment over your
authenticated connection, transcribed there, and discarded. The choice is saved
on this device only, so every computer and browser you use asks for it once.
Set it back to **Off** at any time; a recording in progress is discarded.

If the chosen environment goes offline, voice input waits for it. T3 Code never
substitutes another environment.

For cloud dictation, choose **OpenAI** or **Grok Voice Transcribe** via the environment
you want to use. If it needs a key, enter one and choose **Save and enable**.
You can also choose a [secret provider](secrets.md) instead of **Value** and enter a
reference. Unlock the vault on that environment before dictating. Anyone with
dictation access to the environment can use the key, but only this device opts in.
If a key is already saved, just confirm the provider. After
you stop, the environment forwards your recording and any vocabulary hints to
the selected provider, which bills its API account. No local model download or chat
subscription is needed. Switch back to **This device** on mobile or **Off** on
web and desktop to stop sharing. Removing the key stops that provider for everyone
on the environment.

**OpenRouter** works the same way but has no default model: pick one from its live
speech-to-text catalog when you enable it, or later under **Manage OpenRouter**.
The model choice is yours alone and needs no settings access, so anyone with
dictation access can pick a different model without touching the saved key.
OpenRouter chooses who runs the model. T3 requests zero data retention; your
OpenRouter account can also allow safety retention. If no endpoint qualifies,
dictation fails instead of switching models.
Vocabulary hints are not sent to OpenRouter; dictionary spellings are applied
after transcription. If OpenRouter stops listing your model, dictation stops
until you choose another.

## Set up a model

In **Settings → Voice → Transcription**, download a model and choose **Use model** if it
isn’t already selected. **Test model** lets you try it without sending a message.
If you use the composer microphone before a model is installed, it offers to download one.
The recommendation uses your Voice language, or your system’s preferred languages with **Auto-detect**.

Select the languages you dictate in to compare models that support all of them.
Accuracy shows how often the model got words or characters wrong in each
language; speed is the time to transcribe 30 seconds on a reference GPU. Choose
**All languages** to browse the full catalog. Filtering does not switch your model.

**Advanced** controls GPU or CPU use and when an idle model is unloaded. With hardware set to
**Auto**, a recording that fails on the GPU is retried once on that same
environment's CPU; a GPU you picked yourself reports the error instead. Nothing
is ever retried on another environment. Models marked **Live preview** show
text while you speak. Other models can process long recordings in chunks at pauses
while you record; models with built-in long-form support transcribe when you stop.

## Dictate

Press the microphone in the composer, or `mod+shift+d` (`mod` is Command on
macOS and Ctrl elsewhere). Press again, or the check mark, to finish; `Esc`
discards the recording and leaves your draft unchanged. Recordings last up to
five minutes. Text is inserted at the cursor or replaces the selection you had
when recording started, and the editor is read-only while dictation runs.

Pressing Send while dictating finishes the recording and sends the draft once
the transcript has been inserted. Cancelling also cancels that queued send. In
the other editors, Save, Comment, Reply, Submit review, or Attach works the
same way, and the shortcut targets the editor that has focus, or the composer
when none does. In the desktop browser's annotation editor, the microphone and
the shortcut work while the page has focus; the page you are annotating never
sees the recording, which runs in T3 Code itself.

**Dictation shortcut** in Voice settings picks how the keybinding behaves:
**Auto** tap-toggles or records while held, **Hold** records only while the keys
are down, and **Toggle** always needs a second press. Change the chord itself in
[Keybindings settings](./keybindings.md).

## Improve recognition

- **Language** picks what you speak. **Auto** lets a multilingual model detect
  it. Models that translate offer **Translate to English**.
- **Dictionary** holds names and terms the model should get right. Add an alias
  under a term when transcription keeps producing a particular misspelling.
  Your dictionary is saved on this device. The name of the project you dictate
  in is sent along as a hint.
- **Project dictionary** is vocabulary saved with a project on its environment,
  so everyone who dictates in that project gets the same spellings. Pick the
  project at the top of Settings to edit it; with an environment selected, the
  entries apply to every project there. Project spellings win when they overlap
  your personal dictionary. Each recording carries up to 100 entries from the
  two combined.
- **Silence filtering** is on by default. Your chosen environment skips non-speech
  audio before transcription. Turn it off to keep those sections. Filtering happens
  after upload: it does not grant permission to send audio or reduce how much is sent.
- **Remove filler words** drops hesitation sounds from finished transcripts.

Language and these preferences travel with each recording to the chosen
environment; nothing else about the project is sent.

## Clean up transcripts with a provider

**Transcript cleanup** is a separate choice and is off by default. When on, the
finished transcript and up to 1,024 characters each from before, inside, and
after your selection are sent to the
text generation provider configured on the draft's environment, which fixes
punctuation, numbers, and spoken corrections such as "make it 42, sorry, 24".
Depending on the provider, that can involve an external service. Audio is never
sent to it. Use the built-in instructions or write your own, press **Skip**
while cleanup runs to insert the raw transcript, and if cleanup fails the raw
transcript is inserted.

Cleanup uses the environment's text generation model unless you pick a
**Cleanup model** for that environment, for example a cheaper or faster one.

If cleanup misses the way you correct yourself, set a **Correction cue**: the
word or phrase you say to flag a correction, such as "scratch that". Cleanup
applies the correction only where the context shows one and drops the cue, and
the model hears the cue as a dictionary hint.

## Talk in a voice call

On web and desktop, press **Start voice** in a thread's composer, or run **Start
voice call** from the command palette, and talk. A small model on the thread's
environment answers small talk itself, sends real work to the thread's agent as
an ordinary message, and reads back a short summary when the agent finishes. You
can talk over it to interrupt. The call strip shows what it heard and said, with
**Mute** and **Stop**.

- A call runs on the thread's environment, so **Transcribe with** in
  **Settings → Voice** must name that environment. Calls don't use cloud
  transcription.
- Use headphones if you can. Echo cancellation keeps the voice out of your
  microphone on most speakers, but loud speakers or a laptop on a desk can still
  let it hear itself.
- While a call runs, dictation on that environment waits: both use the same
  speech model.
- The call hangs up after a quiet stretch (10 minutes by default), when you close
  the tab, or when the connection drops.

Calls need the **Voice pack**, the speech and model runtime, which T3 Code does
not ship. Download it once per environment under **Settings → Voice →
Conversation**; starting a call without it opens that row. It is about 170 MB,
or about 330 MB with a GPU build on NVIDIA hardware, saved in T3 Code's data
folder. On an NVIDIA machine without the CUDA 13 runtime installed, it also
fetches NVIDIA's runtime (about 450 MB more, under the
[CUDA EULA](https://docs.nvidia.com/cuda/eula/index.html)); choose **Use CPU** to
skip it. If the GPU build fails its check after download, calls run on the CPU
and the row says so. The pack includes [eSpeak NG](https://github.com/espeak-ng/espeak-ng),
licensed GPL-3.0-or-later.

Calls also need the **Voice model** (about 330 MB) that speaks for the call.
Download it in the same section; starting a call without it opens that row, which
shows the download's progress and, if it failed, why.

Under **Settings → Voice → Conversation**, pick the **Voice**, when to **Hang up
when quiet**, and the **Conversation model**: download a managed model there
before your first call (the larger one needs a GPU to answer quickly), or point
it at an OpenAI-compatible server you already run. Voice
calls are not available on iPhone and Android yet. There is no default shortcut;
bind **Composer: Start or Stop Voice Call** in **Settings → Keybindings**.

### Confirm outward requests

Before a call sends work that would reach past your checkout, such as opening,
merging, or commenting on pull requests and issues, pushing, deploying,
publishing, or messaging someone, the voice reads the request back in one
sentence and waits. Say "yes", "go ahead", or "do it" once it has finished, or
press **Confirm** in the call strip. Saying no, staying quiet for 8 seconds,
saying something else, or hanging up cancels it, and nothing is sent. A
"mm-hm" or "okay" while it is still reading back doesn't count as a yes. The
command palette offers **Confirm voice call request** and **Cancel voice call
request** while one waits, and you can bind both in **Settings → Keybindings**.

## Test and troubleshoot

In **Settings → Voice**, **Test microphone** beside the microphone selector
records up to ten seconds and plays it back in your browser;
the audio stays on this device and is never transcribed, so silent playback
points at the microphone. **Test model** on the selected model shows a transcript using the
same environment, language, and dictionary as the composer, but skips transcript
cleanup even when it is on, so you see what the model heard. Browser recording
needs HTTPS or localhost and microphone permission; for a remote server over
plain HTTP, use the desktop app. If the selected microphone is missing, choose
another or the system default.
