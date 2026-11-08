# Voice front

Checks the voice call's front model through the server's own worker, prompt, schema, parser, and outward backstop. It scores three things on a local GGUF:

- **Decisions**: the 50 utterances the front model was picked with (reply, delegate, note, or none).
- **Outward flag**: 40 labelled requests, scored for the front's `outward` flag and for the flag OR the keyword backstop.
- **False claims**: turns that send nothing whose speech says work was done, sent, or under way. The `claim-` cases reproduce the front replying "I've addressed the reviewer's comment" without delegating; their request cases are controls that must still delegate.

`front` scores the raw model. `shipped` adds the service's `holdOutwardRequest`, which holds a reply or silence to an outward request for a spoken yes.

## Run

It needs a voice pack (Settings > Voice downloads one into `<T3 home>/userdata/speech/voice-pack/<variant>`) and a front GGUF. It loads the model on the GPU when the pack has a GPU build, so take whatever lock your machine uses for the GPU.

```sh
node voice-front/run.ts --model <gguf> --pack <voice pack dir> --out runs/front
node voice-front/run.ts --model <gguf> --pack <voice pack dir> --out runs/front-new --baseline runs/front/results.json
node voice-front/run.ts --regrade runs/front/results.json --out runs/front-regraded
```

`--case <id>` runs one case, `--gpu false` runs on the CPU, and `--regrade` scores saved output again after a grader change. Decoding is greedy (temperature 0), so one sample per case is the whole distribution; compare against a baseline from the same model and pack rather than an absolute score. A full run is 115 decisions, about a minute with Qwen3-4B on CUDA and no API cost.

## Add a case

Add it to `cases.ts` with its source. A false-claim case lists the actions that are right and, where the generic claim check cannot know the context, a `falseClaim` pattern for speech that would be false there.
