# Fallen Road

> Your death becomes someone else's enemy.

A first-person, paper-diorama roguelike built as a Reddit interactive post for the Reddit Hackathon. Players swipe to slash, block and perfect-counter enemy attacks, break guards, and unleash weapon bursts. The full design lives in [Fallen_Road_Game_Design_Document.md](Fallen_Road_Game_Design_Document.md).

**Current status: Hackathon release candidate.** One run carries the player through four road fights, the Gatekeeper, and the Fallen King. Two three-way Gambit rewards, a final pre-throne choice, and two themed Paper Peddler stops shape a build from 15 Gambits and five weapons: **Paper Sword**, **Paper Spear**, **Paper Hammer**, **Paper Daggers**, and **Paper Mace**. Every weapon has its own attack rhythm and Burst. Health persists between fights (+18 on each kill); Gambits alter counter pressure, guard capacity, recovery, healing, Burst gain, and Burst damage.

Six adaptive road archetypes now fill the daily pool: **Road Soldier**, **Shield Bearer**, **Duelist**, **Spear Wraith**, **Bell Templar**, and **Cinder Reaver**. Leg hits slow, weapon-hand hits interrupt telegraphs, and the three final archetypes use dedicated painted paper-puppet rigs. Runtime art is kept near 2 MB while full-resolution generated sources remain under `assets/` for future reslicing.

Every ranked daily run receives the same UTC-seeded road order, Gambit deck, and enemy RNG. The Devvit server issues a short-lived, user-bound run ticket, recomputes scores, retains each traveller's best score in a Redis leaderboard, and shows the top three on Home. A daily defeat preserves a compact weapon/Gambit snapshot as a **Fallen Rival**; another traveller can choose an unranked revenge duel from Home without changing competitive daily scores.

## Haptic Streamline: experiments that did not work

This repository also hosts an iPhone haptics experiment. Its original question was whether a small local decision model, [Laya](https://huggingface.co/convaiinnovations/laya), could infer properties such as “a hammer is heavier than a dagger” from an event description and choose an appropriate vibration. That question drove several failed designs. The record below is here so another project can test these assumptions before building around them.

The tests used published Laya weights through `laya-coreml`, with no model training or inference API. A decision was a choice among labels or a comparison of two items, not generated text. We compared answers with chance, a fixed game-phrase rule, or a rule reading the same supplied facts. Those baselines matter: a plausible answer in a demo is weak evidence if a few known words produce a better answer.

### 1. A short event description did not supply world knowledge

We asked Laya about hardness, weight, roughness, and contact type using the game description in three forms: full state, description only, and separated fields. We tried both multiple choice and true/false questions. **Every tested question/form combination failed** the D5 evaluation. One formulation ranked pairs correctly 88% of the time, but its score range was only 0.05–0.09; it did not produce useful distinctions across the scale. In the description-only contact test, 80% accuracy fell apart when wording changed: 33% of answers changed under paraphrase, and 22% changed when choices were reversed. True/false questions sometimes marked both “heavy” and “light” true for the same object. The English typed-decisions checkpoint also failed this task.

The key missing input was a fact about the object. An event saying that a hammer hits does not state its mass. A classifier can select a label from the words it sees, but this experiment found no dependable way to recover that unstated fact from this checkpoint. The [evaluation script](tools/laya/evaluate.py), [validation cases](tools/laya/validation.json), and [D5 workflow](.github/workflows/laya-eval.yml) show the test contract.

### 2. Examples in the choices reduced one bias, but did not fix the decision

Laya's model card suggests descriptive choice criteria. We added example objects to each choice. The long version needed 101–122 tokens once the state was included, exceeding the phone model's 96-token input limit. A shorter version fit in at most 93 tokens. It reduced the measured choice-order bias to 0.03–0.11, yet the answer spread stayed at 0.06–0.12 and every property question still failed. The contact score dropped from 0.80 to 0.60 in the description-only form. More detailed labels made the prompt less order-sensitive; they did not add reliable knowledge of object properties. The exact choices are in [`rubric.json`](tools/laya/rubric.json).

### 3. Supplying facts helped Laya, but a simple reader did as well or better

We made a game-independent dictionary of one-sentence facts for 70 nouns, appended the relevant fact to the input, and compared Laya with a deterministic rule reading the same words. With the longer 1,024-token Core ML model, Laya passed the hardness and weight checks when the fields were separated. Roughness still lacked sufficient score spread; contact accuracy fell from 0.80 without facts to 0.50 in that form. The rule passed the tested hardness, weight, and roughness cases and reached 0.90 on contact. Supplying the knowledge was the useful change; Laya did not beat a reader of that supplied knowledge.

This comparison has a limit: both the fact dictionary and rule were written with the validation set visible. A fresh noun set is needed before generalizing the result. The [facts](tools/laya/facts.json) and [comparison workflow](.github/workflows/laya-eval.yml) make that bias inspectable.

### 4. Translating sound into words did not teach the model material properties

We extracted features from 130 CC0 Kenney impact sounds, described those features in words, and asked the phone-size Laya model which sound was harder or heavier. On 4,775 hardness pairs Laya scored **0.37** (chance 0.50); on 350 weight pairs it scored **0.47**. Reversing choice order changed 18% and 50% of answers respectively. A rule using one sound feature scored 0.72 and 0.77, but its direction was chosen after examining the data, so those are optimistic diagnostic baselines rather than held-out performance. In five game-sound pairs, adding sound words reduced Laya's result from 0.80 to 0.60.

The sound contains a measurable signal, but Laya did not map words such as “low” and “dull” to the intended physical property. We therefore use the sound features directly for haptic texture. This also has a visible limit: the game's dagger and hammer hit sounds are both dark, with much of their difference in duration, so their textures may feel similar. That prediction still needs an iPhone listening/feeling session. See the [sound evaluation](tools/laya/sound_eval.py), [sound workflow](.github/workflows/laya-sound.yml), and [current texture mapping](src/shared/upscaler/texture.ts).

### 5. Some classification questions collapsed or changed with wording

A three-choice contact question (“shield / body / nothing”) sent almost every answer to “nothing” and scored 0.18–0.33 on game snippets. Removing that option raised the shield/body score to 0.79–0.88, still below a game-word rule at 0.99. The game already reports an exact `outcome`, so model inference adds avoidable error here. A separate paraphrase set of 12 cases favored Laya 0.67 to 0.42, but it is too small to establish a general advantage.

We then tried questions whose answers might be inside the sentence. On 23 game-style snippets, two-order averaged Laya scores were 0.70 for valence, 0.70 for actor, 0.39 for target, and 0.57 for importance. The game-phrase rule scored 1.00, 0.91, 0.91, and 0.95. On 16 newly worded snippets, Laya scored 0.69 for valence and 0.81 for actor versus rule scores of 0.50 and 0.44. Target fell to 0.12. In 16 situation comparisons, Laya scored 0.94 for danger but only 0.51 for decisiveness; the rule scored 1.00 for both. A single choice order changed answers in 12–75% of cases across these question types. We therefore ask surviving questions in both orders and average probabilities by **label**, not by returned array position.

These are small, author-written sets, including the rule phrases. They support a narrow fallback for missing valence and actor labels, not a claim that the model understands arbitrary game events. The cases and scoring live in [`infield.json`](tools/laya/infield.json), [`infield.py`](tools/laya/infield.py), and the [workflow](.github/workflows/laya-infield.yml).

### 6. Four-way haptic “mood” selection also lost to a game rule

We later tested four scene flourishes: anticipation, relief, triumph, and setback. The 48 English sentences comprised 24 situations, each written in game style and as a paraphrase. Laya's two-order accuracy was **24/48 (50.0%)** against **30/48 (62.5%)** for a simple game-phrase rule. It recognized relief in only **1/12** cases; it called six of those triumph and five setback. Reversing the options changed **13/48** answers. The two phrasings of the same situation received the same Laya label in just **12/24** pairs. For example, it labeled “enemy arrow misses player” as setback and “enemy slash attack hits player” as triumph. This four-way selector is absent from the app. The [full report and per-case probabilities](tools/laya/reports/ornament-2026-09-28/README.md) and [script](tools/laya/ornament.py) show the errors.

### 7. An apparently successful IPA was not proof of a working build

Three earlier CI runs published IPAs after Swift compilation had failed. `xcodebuild | tail` hid the compiler's exit code, and an `.app` directory existed despite the failure. The Swift test target also compiled only part of the app. We changed CI to use `pipefail`, check for the app executable, and compile the whole app for the simulator before packaging. We expanded Vitest discovery to include all of `src/client`. This is a build-system failure, separate from the model results, but it changed which artifacts we could trust. The current [iOS workflow](.github/workflows/ios.yml) runs those checks.

### What remains in the demo

The game supplies known outcome and timing values. Its sound features shape event texture directly. The first vibration starts from deterministic signals; a late Laya answer can alter only the remaining phrase. **입력: 축소** deliberately hides valence and actor to demonstrate the narrow question that survived testing. **노면** drives the same upscaler with a continuous stream and explicit asphalt, gravel, or grass properties. The [technical guide](docs/HAPTIC_STREAMLINE.md) and [iPhone install guide](docs/IPHONE.md) explain how to run both.

No current-build device comparison, perceived-quality result, or A/B result is claimed. The Laya results above come from small synthetic or curated sets; the fresh iPhone build has passed web tests, Swift simulator tests, and unsigned IPA packaging, but still needs a physical-device session. For another project, the reusable test pattern is: define labels before inference, compare with a rule using the same information, paraphrase each situation, reverse choice order, and check the exact device input limit before adding prompt examples.

The original CI runs retain summaries; uploaded per-case artifacts may expire. The scripts and test cases linked above remain in the repository:

| Trial | CI run |
|---|---|
| Description-only material D5 | [first](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36232270267), [recheck](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36235848462) |
| Choice examples | [shortened rubric](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36238258531) |
| Supplied object facts | [fact and rule comparison](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36240342450) |
| Shield/body/none | [contact choices](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36242801348) |
| Sound words to material | [sound evaluation](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36243920968) |
| In-text valence/actor | [field evaluation](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36249568594) |
| Four scene flourishes | [ornament evaluation](https://github.com/Nattentia/fallen-road-haptics/actions/runs/36361761537) |

## Stack

Built from the official [Devvit Phaser starter](https://github.com/reddit/devvit-template-phaser):

- [Devvit Web](https://developers.reddit.com/) — Reddit app platform (Redis permission enabled)
- [Phaser 4](https://phaser.io/) — game engine, fixed 1280x720 logical resolution, `Scale.FIT`
- [Hono](https://hono.dev/) — server routes under `/api/*`
- [Zod](https://zod.dev/) — request/response validation on server and client
- [Vitest](https://vitest.dev/) — unit tests for all pure combat logic
- TypeScript strict mode, ESLint, Prettier
- Devvit MCP configured in [.mcp.json](.mcp.json) for agent documentation search

## Getting started

```bash
npm install
npm run login    # authenticate the Devvit CLI with your Reddit account
npx devvit init  # bind this project to a new Devvit app (keeps existing code)
npm run dev      # playtest live on Reddit
```

To preview the client without Reddit: `npm run build`, then serve `dist/client`
(e.g. `python3 -m http.server 4173 --directory dist/client`) and open
`game.html`. The `/api` endpoints are unavailable in this mode and fail
gracefully.

## Commands

| Command                             | Purpose                            |
| ----------------------------------- | ---------------------------------- |
| `npm run dev`                       | Devvit playtest on Reddit          |
| `npm run build`                     | Production build (client + server) |
| `npm test`                          | Run unit tests                     |
| `npm run type-check`                | Strict TypeScript build check      |
| `npm run lint`                      | ESLint                             |
| `npm run prettier`                  | Format                             |
| `npm run verify`                    | type-check + lint + test + build   |
| `npm run deploy` / `npm run launch` | Upload / publish the app           |

## How the combat slice plays

- **Attack** — swipe (mouse drag or touch) through the soldier. Direction is
  classified into 8 ways; long, deliberate swipes become **heavy attacks**.
- **Weak point** — the head sways constantly; hitting it deals 1.5x damage and
  extra burst.
- **Block** — hold the shield button (touch), Space, or right mouse.
  Blocks reduce damage by 75% but drain your guard meter.
- **Perfect counter** — press the shield in the final 240 ms of the enemy's
  telegraph (watch for the golden flash on the blade). Negates the hit,
  staggers the soldier, damages his guard, and grants a large burst chunk.
- **Guard break** — both sides. An emptied guard meter means seconds of
  crumpled, defenseless paper.
- **Burst** — fill the meter, then press BURST (or Q). Sword flurries, spear
  thrusts, hammer guard-breaks, dagger storms, and mace impacts each behave
  and animate differently.
- The soldier telegraphs, blocks, side-steps, recovers, and can be
  guard-broken; fell him for victory, or die and rise again.

## Architecture

```text
src/
  shared/            # runs on client AND server, fully unit-tested
    balance/         # ALL tuning data: player, weapons, enemies, gestures,
                     # hit zones, burst gains — no numbers in logic code
    combat/          # pure logic: gesture classifier, segment-vs-zone hit
                     # detection, damage, guard meters, counter timing, burst,
                     # EnemyBrain (time-driven FSM with phases + counter stance),
                     # pattern tracking + capped adaptation, directional guard
    api.ts           # Zod schemas for /api contracts
    run/             # immutable run state, seeded daily generation, scoring
  client/
    game.ts          # Phaser config (1280x720 FIT)
    scenes/          # Boot -> Preloader -> Home (foe select) -> Battle
    combat/          # SwipeInput (pointer capture)
    entities/        # PaperEnemyView (data-driven cutout builder), PlayerRigView
    ui/              # Hud, backdrop, effects, theme
  server/
    index.ts         # Hono app
    routes/api.ts    # init, daily tickets/scores/leaderboard, Fallen Rival routes
```

Design rules enforced in code:

- **Balance lives in data files** (`src/shared/balance/`), never inline.
- **Pure combat logic is shared** so the server can later validate run
  submissions with the same math the client simulates.
- **Hit zones derive from live sprite positions** — a dodge really moves the
  hitbox; there is no hidden miss chance after a visually landed hit.
- The enemy brain is a plain TypeScript FSM with injected time and RNG.

## Testing

`npm test` — 118 tests covering gesture classification (distance / duration /
velocity thresholds, 8-direction classification, heavy detection, taps),
segment-vs-circle/rect hit detection and zone priority, damage and block
math, guard damage / break / regeneration timing, perfect-counter windows,
burst gain/activation, player-pattern tracking and capped weight adaptation,
directional guard resolution, and the full enemy brain lifecycle (attack
cycles, defensive cooldowns, counter stance / riposte / its cooldown,
interrupts, slows, phase transitions, burst lockdown).

## Roadmap (per the design document)

1. ~~Combat vertical slice~~
2. ~~Enemy variety: player-pattern adaptation, Shield Bearer, Duelist, phase framework~~
3. ~~Weapons (spear, hammer), Gambits, reward & merchant scenes; the Gatekeeper boss on the phase framework~~
4. ~~Full run structure, tutorial, travel, results & scoring~~
5. ~~Server-issued daily seed, leaderboards, run validation, **Fallen Rival system**~~ ← **you are here**
6. ~~Painted enemy/weapon art, mobile polish, submission verification~~
