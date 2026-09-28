# Haptic Streamline

A small iPhone experiment in adding context-sensitive haptics to a game that already has plain vibration. Fallen Road is the combat example; **노면** is a small road-surface example using the same upscaler engine.

```text
game vibration + event / stream / gauge / clock signals
                     ↓
          TypeScript upscaler
    sound features → texture and timing
                     ↓
             play / revise / drive
                     ↓
           Swift + Core Haptics
```

The first vibration starts from game-supplied information. Effect-sound analysis changes the texture of event haptics without changing their outcome or size. A late decision can replace only the remaining part of a sounding phrase. The game owns exact outcomes, damage and timing. Continuous streams such as road contact are held and updated rather than restarted on every frame.

## Try it

1. Build the web client with `npm ci && npm run build`. `dist/client/game.html` previews the game in a browser; vibration requires the iPhone wrapper.
2. Install the [unsigned IPA](https://github.com/Nattentia/fallen-road-haptics/releases/download/ios-latest/FallenRoadHaptics.ipa) using [the iPhone guide](IPHONE.md).
3. In the app, switch **햅틱** between **기본+업스케일** and **기본만** while playing. The latter plays the game's original vibration.
4. Switch **입력: 전체 / 축소** to compare complete game signals with a run in which the upscaler receives no valence or actor labels. Switching restarts the game. The reduced mode asks the on-device Laya model; missing or late answers leave the deterministic score in place.
5. Open **노면**, start the drive, then change speed and surface. This example sends one `stream` signal whose explicit `material` changes. It uses the same upscaler and native player as combat.
6. Use **기록 저장** to export the signal and command JSONL. `tools/sceneExport.test.mjs` can turn a recording into AHAP files and comparison curves.

The road example supplies surface properties directly. A surveyed [MIT browser kart game](https://github.com/nasilvae/old-san-juan-kart) has track and surface data, but this demonstration keeps the second adapter small and original. Adding a repeating sound ID to stream signals remains a possible extension; the current stream contract uses explicit material.

## What was checked

| Check | Result |
|---|---|
| Web type check, lint, tests, production build | Automated in `npm run verify` and CI |
| Cross-language command decoding and app compilation | macOS simulator CI |
| Local Laya inference speed | Earlier iPhone lab: about 5.7 ms per question; four questions p95 23 ms |
| Laya text judgments | Offline: valence about 0.69–0.70, actor 0.70–0.81; sensitive to choice order, so each is asked twice |
| Laya scene flourish selection | [48-sentence experiment](../tools/laya/reports/ornament-2026-09-28/README.md): 24/48 correct vs 30/48 for the game-phrase rule; not used in the app |
| Current build's feel and reduced-input comparison | Requires an iPhone session; no result is claimed yet |

Laya is used only when the reduced mode hides game labels. It runs on the phone through the bundled Core ML model. There is no inference API and no GPU training step. The normal mode preserves the game's own labels and uses the sound-to-haptic conversion. Input phrases outside the prepared phone vocabulary are skipped, leaving the deterministic path.

For a reproducible synthetic command export, run `SCENES=1 npx vitest run tools/sceneExport.test.mjs` on macOS/Linux, or set `$env:SCENES='1'` before the command in PowerShell. The export writes `out/scenes/<scene>/base.ahap`, `upscale.ahap`, `both.ahap`, `curves.json`, and `compare.svg`. Install `ffmpeg` to include the game's decoded effect-sound features in this replay.
