# Haptic Streamline

The original goal was a haptic counterpart to DLSS: take the simple vibration and event data a game already has, then add detailed, context-sensitive feedback in real time. A Jev-like decision model would score the proposed perceptual controls for each event—strength, roundness, hardness, roughness, and tension. Five fixed scores could not describe how a sensation starts, develops, and fades, so the output design evolved into a motif and time-varying curves. A deterministic renderer would turn the decisions into a Core Haptics pattern on iPhone, adding sensations beyond a standard vibration pulse. A light game adapter, rather than a separate hand-authored material table for every game, was meant to make the same system useful across genres.

This repository records the attempt and its failure modes. The model-driven material path failed the evaluation. The playable artifact uses game signals and effect-sound features for most of its haptics, with a narrow on-device Laya demonstration. All decision-quality results below come from published Laya weights; Jev provided the original decision interface, not the tested model.

## How the design changed

### 1. Jev-style decisions for every event

[Jev](https://docs.typesafe.ai/introduction) offered the right *interface*: a state and a question produce a choice or score without generating a paragraph. The proposed controller would ask several questions about one event, then use the answers to set haptic controls. Jev itself was available as an HTTP API; its [published end-to-end latency](https://typesafe.ai/blog/introducing-system-one-models-and-jev) was 70–500 ms, and we found no downloadable iPhone weights or supported local runtime. An input-triggered vibration could not depend on that round trip. We kept the decision format and moved the experiment to the open-weight [Laya](https://huggingface.co/convaiinnovations/laya) model through `laya-coreml`.

An earlier iPhone lab measured about 5.7 ms per question and a 23 ms p95 for four questions. Local decision speed was plausible, so the next tests focused on decision quality.

### 2. Infer material properties from an event sentence

The first semantic test asked Laya to read descriptions such as a weapon hitting a target and rate hardness, weight, roughness, or contact type. We tested full state, description-only, and separated-field inputs, each with choice and true/false questions. All 12 question/form combinations failed the D5 acceptance checks. One form ordered pairs correctly 88% of the time, yet its score spread was only 0.05–0.09. A description-only contact result reached 80% accuracy, but 33% of answers changed under paraphrase and 22% changed when the choices were reversed. True/false questions sometimes accepted both “heavy” and “light” for the same object.

The missing information was physical knowledge. A sentence saying that a hammer hits a shield identifies an event; it leaves the objects' mass and surface properties unstated. Laya's choice head scored the supplied labels without reliably recovering those properties. An English typed-decisions checkpoint also failed this task. The [evaluation script](tools/laya/evaluate.py), [cases](tools/laya/validation.json), and [D5 workflow](.github/workflows/laya-eval.yml) preserve the test.

### 3. Explain each choice with example objects

We added concrete examples to the choices so that “hard” and “heavy” had a clearer rubric. Full descriptions took 101–122 tokens with the state, beyond the phone model's 96-token input limit. A shorter rubric fit within 93 tokens and reduced choice-order bias to 0.03–0.11. The property questions still failed; their score spread remained 0.06–0.12, and description-only contact accuracy fell from 0.80 to 0.60. Better choice wording reduced one source of instability without supplying the object knowledge. The exact prompts are in [`rubric.json`](tools/laya/rubric.json).

### 4. Supply object facts before asking Laya

We wrote one-sentence physical facts for 70 nouns and appended the relevant fact to the event. With a longer, 1,024-token Core ML model, Laya passed hardness and weight checks in the separated-field format. Roughness lacked enough score spread, and contact accuracy in that format fell from 0.80 to 0.50. A deterministic rule reading the same supplied facts passed the tested hardness, weight, and roughness checks and reached 0.90 on contact.

The facts supplied the information that the sentence lacked. Maintaining them would require a knowledge source for objects introduced by each game, contrary to the intended light adapter. On these cases, the rule matched or exceeded Laya while reading the same facts. Both the fact dictionary and the rule were written with the validation set visible, so these results need a fresh noun set before they can support a general claim. See the [facts](tools/laya/facts.json) and [comparison workflow](.github/workflows/laya-eval.yml).

### 5. Describe effect sounds in words and ask Laya about material

Effect sounds already carried authored cues about an impact. We extracted features from 130 CC0 Kenney sounds, converted them to words such as “low” and “dull,” and asked the phone-size Laya model to compare hardness and weight. It scored 0.37 on 4,775 hardness pairs and 0.47 on 350 weight pairs, against 0.50 chance. Reversing the choices changed 18% and 50% of answers. In five game-sound pairs, adding sound words reduced Laya's result from 0.80 to 0.60.

A rule using one sound feature scored 0.72 and 0.77, although the feature direction was chosen after inspecting the data; these are diagnostic, not held-out scores. The sound had measurable variation, while Laya's translation of that variation into material labels was unreliable. The [sound evaluation](tools/laya/sound_eval.py) and [workflow](.github/workflows/laya-sound.yml) contain the method.

### 6. Map sound features directly to haptic texture

The implemented route passes sound features directly to the renderer. Attack, brightness, decay, noise, and frequency-band energy shape the onset, body, grain, and tail of a haptic phrase. Game-provided magnitude and outcome continue to determine the event's size and identity. Explicit `material` values take precedence when a game supplies them. This turns an authored audio cue into a tactile cue without asking a language model to infer an object's physical properties. The mapping lives in [`texture.ts`](src/shared/upscaler/texture.ts); the [technical guide](docs/HAPTIC_STREAMLINE.md) describes the signal and playback path.

This route has a concrete limit: the demo's dagger and hammer hit sounds are both dark and close in texture; much of their difference comes from duration and game-provided magnitude. The code produces different commands, but an iPhone listening-and-feeling session has not established how distinguishable those commands are. A second, small road-surface demo uses explicit asphalt, gravel, and grass properties with the same continuous-stream renderer.

## What remained of Laya

A separate contact question exposed answer-label collapse. With **shield / body / nothing** as choices, Laya sent nearly every game snippet to “nothing” and scored 0.18–0.33. Removing that option raised shield/body accuracy to 0.79–0.88, while a rule using game words reached 0.99. The game already supplies the exact contact outcome, so the app uses that field. A 12-case paraphrase set favored Laya 0.67 to 0.42, too small to establish a general advantage. The [contact run](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36242801348) records the experiment.

We also tested decisions whose answers were more likely to appear *in* the event sentence. On 23 game-style snippets, two-order averaged Laya accuracy was 0.70 for valence, 0.70 for actor, 0.39 for target, and 0.57 for importance. A game-phrase rule scored 1.00, 0.91, 0.91, and 0.95. On 16 newly worded snippets, Laya scored 0.69 for valence and 0.81 for actor, against rule scores of 0.50 and 0.44; target fell to 0.12. In 16 situation comparisons, danger ordering scored 0.94 while decisiveness scored 0.51; the rule scored 1.00 on both. A single choice order changed answers in 12–75% of cases across these questions. The app therefore asks the surviving valence and actor questions in both orders, averages probability by label, and uses them only in **입력: 축소** (“reduced input”), a demonstration that hides those two game-supplied fields. The first vibration starts from game data; a timely Laya answer can adjust only the phrase that remains. The [in-text cases](tools/laya/infield.json), [scorer](tools/laya/infield.py), and [workflow](.github/workflows/laya-infield.yml) show this narrower test.

A separate attempt asked Laya to select four scene flourishes: anticipation, relief, triumph, and setback. It got 24 of 48 English sentences right (50.0%); a simple game-phrase rule got 30 of 48 (62.5%). Relief was correct in only 1 of 12 cases. Reversing the options changed 13 of 48 answers, and two phrasings of the same situation received the same Laya label in only 12 of 24 pairs. This selector is absent from the app. The [per-case report](tools/laya/reports/ornament-2026-09-28/README.md) records the results.

These were small, author-written test sets. They support a limited fallback for missing labels and show why an event sentence was insufficient for the original material controller. They do not measure understanding of arbitrary games.

## Build evidence and remaining test

Three early CI runs published IPA files after Swift compilation had failed: `xcodebuild | tail` hid the compiler's exit code, and an `.app` directory existed despite the failure. The [iOS workflow](.github/workflows/ios.yml) now uses `pipefail`, checks the app executable, and compiles the whole app for the simulator before packaging. This made the later build evidence usable.

The current build has passed web checks, Swift simulator checks, and unsigned IPA packaging. Its actual iPhone feel, event distinguishability, and the **base only** versus **base plus upscaler** comparison remain unmeasured. The [iPhone guide](docs/IPHONE.md) explains how to run those comparisons. For anyone evaluating a Jev-like controller, this repository provides the [test cases](tools/laya/validation.json), [scripts](tools/laya/evaluate.py), [in-text cases](tools/laya/infield.json), and [per-case scene results](tools/laya/reports/ornament-2026-09-28/README.md): compare against a rule using the same information, paraphrase each event, reverse the choices, and record device latency separately from decision quality.

| Experiment | Recorded CI run |
|---|---|
| Description-only material decisions | [First run](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36232270267), [recheck](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36235848462) |
| Example-annotated choices | [Short rubric](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36238258531) |
| Supplied object facts and rule baseline | [Fact comparison](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36240342450) |
| Shield/body/nothing choices | [Contact evaluation](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36242801348) |
| Sound words to material labels | [Sound evaluation](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36243920968) |
| In-text valence and actor | [Field evaluation](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36249568594) |
| Four scene flourishes | [Ornament evaluation](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36361761537) |

Per-case CI artifacts may expire; the scripts and cases linked above stay in this repository.

## Testbed and reproduction

[Fallen Road](Fallen_Road_Game_Design_Document.md) is the swipe-combat game used for event timing, effects, and base-vibration comparisons. The game adapter sends event, continuous stream, gauge, and clock signals to the TypeScript upscaler. The native iPhone wrapper plays the resulting commands through Core Haptics. The small road-surface screen exercises the same stream path with a different kind of game input. [Architecture and controls](docs/HAPTIC_STREAMLINE.md) · [iPhone installation](docs/IPHONE.md)

For a browser preview of the game without native vibration, run `npm ci && npm run build`, serve `dist/client`, and open `game.html`. `npm run verify` runs type checks, lint, tests, and the build. The [iOS workflow](.github/workflows/ios.yml) packages an unsigned IPA; installation and the device exercises are described in the iPhone guide. Evaluation scripts under `tools/laya/` run in the documented macOS workflow with the published Core ML model. The original game design and Devvit implementation remain in the [design document](Fallen_Road_Game_Design_Document.md) and `src/`.
