# Connect Café - Asset List (Phase B)

Based on Humayun's concept images (2026-09-25: day = light theme, night = dark theme; top-down 3/4 view; small tables with one teammate each, a big group table, beds with sleeping teammates on the right, name tags with online dots). The concept is AI-generated, so it's a direction, not a spec - improvements noted at the bottom.

## Format rules (apply to everything)

- **PNG with a transparent background** (not JPG, not WebP for source files).
- **One consistent art style and camera angle** for everything (the concept's 3/4 top-down, light coming from the same side). Mixing packs almost always looks wrong - one pack (or one artist) for the whole café.
- **Size:**
  - *Pixel-art pack:* original size, no enlarging (16×16 or 32×32 grid). I scale it up crisply in code.
  - *Illustrated/painted pack (like the concept images):* at least **2× the size it appears on screen**, e.g. a character ~64 px tall on screen → 128 px+ source; a small table ~160 px → 320 px+.
- **Every object a separate image** (or a sprite sheet with a JSON/Tiled file that says where each one is). Not a single flattened picture of the whole room - the room has to grow and rearrange with team size.
- **License file included** that allows use in commercial software (an internal company app counts as commercial).
- Optional but welcome: source files (`.aseprite`, `.psd`).
- Put everything unzipped in `assets-incoming/cafe/` in the project folder (or the shared Drive folder), plus the concept images.

## 1. Room

| Asset | Notes |
|---|---|
| Floor | Seamless/tileable (stone or wood like the concept), or several tiles that fit together |
| Walls / edges | Top wall, side walls, corners - or a hedge/garden border like the concept |
| Entrance / door | One |
| Windows | 1-2 styles |
| **Night versions** | If the pack has night/lit variants, include them. If not, I'll do night lighting in code (darken + lantern glow), which is how the concept's dark version can be achieved |

## 2. Furniture

| Asset | Notes |
|---|---|
| **Small table** | One person per table in the concept (plus room for a second chair when someone hops over). Round, matches the concept |
| **Chairs - 4 facing directions** | Facing up, down, left, right. Separate from the tables so seats can go anywhere around a table |
| **Big group table** | Seats **8+**. Round (as Humayun described) or long like concept panel 4 - pick one |
| **Bed** | Single bed, facing one direction; will be repeated for every offline teammate. Blanket as a separate layer if possible (so a character can lie "under" it) |
| Laptop / mug / notebook | Small props for tables (optional, the concept has them) |
| Counter / barista bar | Optional, gives it "café" |

## 3. Decoration

Plants in pots (3-5 kinds), hanging lanterns / wall lamps (lit + unlit if available), a **blank** chalkboard sign (I write the text in code - the concept's "Good Ideas Better Together"), a **blank** banner/flag (I place the Blue Kite logo on it in code), rug, bookshelf, bushes/flowers for the garden edge.

## 4. Characters - preset lineup

**At least 12-16 different characters** (more than the team, so there's choice and room to grow), each with:

| Pose | Required? |
|---|---|
| **Sitting, facing down / up / left / right** (4 images) | Required - people sit on every side of a table |
| **Sleeping** (lying down, eyes closed) - or a head-on-pillow image that fits the bed | Required - offline teammates |
| Standing, facing down | Required - shown while being dragged, and for the character picker |
| Small idle animation while sitting (2-4 frames, e.g. typing/breathing) | Nice to have |
| Walking animations | NOT needed (we're using instant hop) |

Characters must fit the chairs and bed at the same scale (same pack solves this).

## 5. Effects (I can make these in code if the pack doesn't have them)

"Poof" cloud for the hop (4-6 frames), "zZZ" bubble, glow ring around a table in a call.

## Improvements over the concept (to confirm with Humayun)

- The call control on a table (concept panel 3) shows a camera button - Connect is voice-only, so it becomes mic, hang up, and "add someone."
- The stray "All" tag in the top-right corner of the concept is an AI glitch - it'll go.
- Group table: concept panel 4 shows a long table; Humayun said round. Either works - one choice for the pack.
- Names are clean and readable (the AI garbled some, e.g. "Humsyon Mir", "Ess").
