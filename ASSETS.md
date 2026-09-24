# Fallen Road — Art & Audio Supply Guide

The game currently draws everything procedurally (dusk-silhouette style). Real
art replaces the procedural pieces **automatically** — no code changes needed
for anything in Tier 1.

## How to add an asset

1. Drop the file under `src/client/public/assets/` (subfolders are fine).
2. Add one entry to `src/client/public/assets/manifest.json`:

```json
{
  "images": [
    { "key": "bg-tower", "file": "backdrop/tower.png" },
    { "key": "player-sword", "file": "player/sword.png" }
  ]
}
```

3. Rebuild (`npm run dev` playtest or `npm run build`). The preloader loads
   every manifest entry; anything not supplied keeps its procedural fallback.

The `key` is the contract — use the exact keys below. The `file` path is
yours to organize.

## Art direction

- Canvas is **1280×720**, landscape, mostly viewed on phones.
- Dusk silhouette look: near-black shapes against a burning twilight horizon.
  Bodies read as dark masses; light is reserved for rims, eyes, and windows.
- Palette anchors (from `src/client/ui/theme.ts`): sky `#171226 → #453054 →
  #b05c33`, silhouettes `#130f1d`–`#2a2138`, warm glow `#ffb45e`, rim light
  `#8d7ab5`, accents — guard blue `#4f8fdd`, burst amber `#ffb347`, dodge
  teal `#7fc9a0`, danger red `#d94f3d`.
- PNG with transparency (WebP also works). Deliver at the on-canvas pixel
  sizes below — they render 1:1 on the 1280×720 stage.

## Tier 1 — wired now, drop in and they appear

| Key | What | Size (px) | Notes |
|---|---|---|---|
| `dusk-sky` | Full sky painting | 1280×720 | Replaces the gradient. Keep the horizon glow around y≈460. |
| `bg-tower` | The dark tower | ~340×560 | Base sits on the horizon; bottom edge = ground line. Bake in lit windows. |
| `tree-pine` | One pine silhouette | ~256×480 | Trunk base at bottom-center. Reused at many scales, incl. the travel fly-past. |
| `fog-band` | Soft horizontal fog strip | 512×128 | Tileable horizontally, faded top/bottom edges. |
| `player-sword` | First-person sword + fist | ~260×560 | Blade points up, grip centered at 85% of the height (rotation pivot). |
| `player-shield` | Round shield, front view | ~512×512 | Circular, centered. The blue guard-glow ring is drawn over it by code. |
| `paper-grain` | Film grain tile | 256×256 | Tileable speckle, subtle. |
| `paper-vignette` | Edge darkening | 640×360 | Transparent center, dark corners. Stretched to full screen. |

## Tier 2 — supply these and I wire them next (biggest visual win)

Enemy art. Each foe is an animated rig (independent head/torso/arms/legs with
hit zones), so it needs **separate body-part PNGs**, not one flat image:

- Per archetype (`road-soldier`, `shield-bearer`, `duelist`, and the
  `gatekeeper` boss — bigger, tower shield, gold eyes): torso, head,
  weapon arm + weapon, off arm (shield where the foe carries one), legs.
- Roughly 2× final size (torso ≈ 300×400; gatekeeper ≈ 1.3× the others) so
  parts stay crisp when zoomed.
- Same silhouette language: dark bodies, per-archetype glowing eye color
  (soldier amber, bearer blue, duelist red, gatekeeper gold).

Also useful, small: HUD icons 64×64 (heart, shield, spark, dodge chevrons),
a slash-arc streak texture (~512×128, white on transparent), an ember dot.

## Wired SFX (Kenney, CC0)

Combat sounds live in `src/client/public/assets/sfx/` as `<key>_<n>.ogg` and
are played through `src/client/audio/sfx.ts`. All files come unmodified from
Kenney's CC0 packs (license text: `sfx/LICENSE-kenney.txt`), except
`telegraph_*` which were gain-boosted +16 dB.

| Key | Source pack → files |
|---|---|
| `swing_light` / `swing_heavy` | Casino Audio → card-slide / card-shove (paper swish) |
| `hit_sword` | RPG Audio → knifeSlice |
| `hit_dagger` / `hit_spear` / `hit_hammer` / `hit_mace` | Impact Sounds → impactSoft_medium / impactPunch_medium / impactWood_heavy / impactPunch_heavy |
| `hit_weak` | Impact Sounds → impactPlate_medium |
| `enemy_block` / `parried` / `player_block` | Impact Sounds → impactMetal_medium / impactMetal_heavy / impactPlate_heavy |
| `player_hit` | Impact Sounds → impactPunch_heavy |
| `counter` / `guard_break` | Impact Sounds → impactBell_heavy / impactGlass_heavy |
| `dodge` / `telegraph` / `felled` | RPG Audio → cloth / drawKnife / bookClose |
| `ui_tap` | Interface Sounds → click |

## Tier 3 — audio (SFX wired above; music and mute button still open)

- One ambient/combat music loop (60–90s, OGG + M4A, ≤1 MB each).
- SFX: swipe ×2–3, blocked clang, perfect-counter chime, guard break,
  dodge whoosh, enemy death, UI tap.
- Reddit requires audio to start only after a user gesture and a visible
  mute button — I'll handle both when wiring.

## Sourcing & constraints

- Any source works: hand-drawn, commissioned, AI-generated, or CC0 packs
  (Kenney, OpenGameArt, itch.io). **You must hold usage rights** — check the
  hackathon rules on AI-generated art, and note the license here per file.
- Keep the whole bundle lean: Reddit wants webview posts loading in ~1s on
  mobile. Target **≤3–4 MB total** art; PNG-8/posterized exports suit the
  silhouette style well.
