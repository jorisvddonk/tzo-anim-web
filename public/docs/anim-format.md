# The TZO animation format ("tzo-anim")

**Version 1.0** — the animation extension that [tzo-c](https://github.com/jorisvddonk/tzo-c)'s
`anim.c` and the [tzo-anim web player](https://github.com/jorisvddonk/tzo-anim-web) implement.

This document specifies **only the animation additions on top of TZO**. The virtual machine
itself — instruction set, stack semantics, `goto`/`jgz`/`{`/`}` behaviour, the JSON instruction
representation — is defined by the core TZO specification:
<https://github.com/jorisvddonk/tzo#readme>.

Everything below is what you need to build a player for `tzo-anim` programs in any language.

---

## 1. Overview

A **tzo-anim program** is a TZO program (a JSON instruction list plus a label map) that draws
animation frames by calling four *foreign functions* the host provides, and that keeps its
animation state in the TZO **context** under `anim_anim_<i>_*` keys.

Programs are produced by UQMAnimationTool's TZO exporter
(*File → Export TZO animation (.json)*) or written by hand; the format is small enough to
generate or edit directly.

The host has four responsibilities:

1. run the TZO VM (core TZO),
2. implement the four foreign functions from §5,
3. keep a frame buffer and present it (§6),
4. drive the VM at a steady tick rate (§9).

All animation logic — which frame is visible, when to advance, yo-yo bouncing, random frames —
lives **inside the program**. A host never needs to interpret animation types or durations
itself; it only runs the program and provides the drawing primitives.

```
 program JSON ──parse──► program list + label map
                              │
                              ▼
                       TZO VM (core spec) ──foreign calls──► anim extension (this document)
                              ▲                                    ├─ loadImage → texture table
                              │                                    ├─ beginDraw → frame start
                              └────────── context ──────────────────┤─ drawFrame → blit a texture
                                                                   └─ endDraw   → present the frame
```

---

## 2. The program file

The file is a JSON object in the standard TZO "VM state" representation:

```json
{
  "context": {},
  "exit": false,
  "pause": false,
  "labelMap": { "mainAnimationLoop": 440 },
  "programList": [ /* instructions, see the core TZO spec */ ],
  "programCounter": 0,
  "stack": []
}
```

| Key | Required | Meaning |
|---|---|---|
| `programList` | **yes** | array of instructions (`push-number-instruction`, `push-string-instruction`, `invoke-function-instruction`) |
| `labelMap` | recommended | `{ "<label>": <instruction index> }`. `mainAnimationLoop` is the conventional entry point of the animation loop. |
| `context` | no | initial context values (usually empty — the program initialises its own state) |
| `stack` | no | initial stack (usually empty) |
| `programCounter` | no | initial program counter (usually `0`) |
| `exit`, `pause` | no | initial VM flags (usually `false`) |

`tzo-c`'s `anim.c` reads only `programList` and `labelMap`; the other keys are part of the
reference VM state and are useful for debugging or resuming.

Instructions may carry extra keys:

* `comment` — free-form text, **ignored** by every implementation (useful in generated files),
* `label` — defines a label at that instruction. If the same label is also present in
  `labelMap`, `labelMap` wins and the instruction-level label should be ignored
  (the TypeScript reference VM throws on the duplicate otherwise).

A file is considered a tzo-anim program if it parses as JSON and `programList` is an array.

### Content files

`loadImage` receives a **path string** exactly as stored in the program, for example
`base/comm/yehat/yehat-000.png` (UQM content tree) or `frame0.png` (flat export).

The host decides how to resolve it:

* `anim.c` resolves through PhysFS, inside a mounted UQM content archive,
* the web player resolves inside the loaded `.zip` / folder, trying the exact path first and
  the file name second (case-insensitively), so archives that keep a directory prefix work.

Recommended resolution order for new implementations: **exact path → file name**, and report
missing files instead of failing the whole program (draw a placeholder or skip the frame).

---

## 3. Textures

Every `loadImage` call creates a **texture**:

| Field | Type | Source |
|---|---|---|
| `width`, `height` | integer | decoded image size |
| `pixels` | RGBA8 buffer | decoded image, **alpha preserved** |
| `hotspotX`, `hotspotY` | integer | arguments of `loadImage` |

Textures are numbered **0, 1, 2, … in the order the `loadImage` calls happen**. That number is
what `drawFrame` receives.

A texture is drawn at scene position:

```
x = -hotspotX
y = -hotspotY
```

so `hotspotX`/`hotspotY` are the UQM `.ani` offsets of the image relative to the hotspot
(negative values put the image to the right/below the origin). `anim.c` stores exactly the
`xoff`/`yoff` columns of a `.ani` line here.

---

## 4. Initialisation protocol

Programs are loaded in two phases, because `loadImage` must be **synchronous** while the
program runs, but image decoding is usually asynchronous:

```
Phase A — discover
    create a VM
    run the program with a *recording* loadImage (record path/hotspotX/hotspotY, assign indices)
    the program reaches `pause` at the end of its initialisation block
    ⇒ you now know every texture the program will ask for, in order

Phase B — decode
    fetch + decode every recorded path
    (cache by path; a program may load the same image twice)

Phase C — run
    create a fresh VM with the real loadImage (hands out the decoded textures by index)
    run the program once more → it pauses again after initialisation
    size the frame buffer from the textures (§6) and clear it
    start ticking (§9)
```

Programs that load images *after* initialisation are outside the format's contract; hosts may
scan the whole instruction list for `loadImage` calls instead of running Phase A if they prefer
that trade-off.

---

## 5. Foreign functions

The host must provide these four functions to the VM. Stack notation: **top of stack first**.

| Function | Pops | Effect |
|---|---|---|
| `loadImage` | `path: string`, `hotspotX: number`, `hotspotY: number` | decodes/registers the image as the next texture index; records its hotspot. Produces no value. |
| `beginDraw` | – | marks the start of a frame. `anim.c` implements it as a no-op. |
| `endDraw` | – | marks the end of a frame and **presents** the frame buffer to the screen. |
| `drawFrame` | `textureIndex: number` | blits that texture onto the frame buffer at `(-hotspotX, -hotspotY)`. |

Because the stack is LIFO, a program pushes `hotspotY`, then `hotspotX`, then `path`:

```json
{ "type": "push-number-instruction", "value": -32 },
{ "type": "push-number-instruction", "value": -64 },
{ "type": "push-string-instruction", "value": "base/comm/yehat/yehat-001.png" },
{ "type": "invoke-function-instruction", "functionName": "loadImage" }
```

`hotspotX = -64`, `hotspotY = -32` for that call.

Error handling: a `drawFrame` index that was never loaded is a program error; report it and
stop the tick rather than crashing the host.

---

## 6. Rendering

### 6.1 Frame buffer

The frame buffer is **persistent across frames**. `drawFrame` composites onto whatever is
already there; `endDraw` presents the whole buffer.

This matters: many programs draw their background **once** (see `_active = -1` in §7) and rely
on it staying on screen. A host that clears the buffer every frame would lose the background of
such programs. Do **not** clear between frames.

(`anim.c` works this way: `blit_screen_0` is allocated once and never cleared.)

### 6.2 Blitting

For each pixel of the texture that falls inside the buffer:

* `alpha == 0` → leave the destination untouched (transparent),
* `alpha == 255` → copy the RGB values (idempotent: redrawing the same frame changes nothing),
* `0 < alpha < 255` → normal source-over compositing.

Clipping to the buffer bounds is required.

> **Note on `anim.c`:** the C demo converts every image to an indexed palette, ignoring alpha,
> and copies *every* pixel (`colorkey = -1`), so transparent pixels become palette entry 0
> (black). A new implementation should keep the alpha channel; that is what the web player does
> and what the artwork expects.

### 6.3 Buffer size

Recommended: the **bounding box of every texture rectangle**, using the hotspot offsets:

```
minX = min over textures of (-hotspotX)
minY = min over textures of (-hotspotY)
maxX = max over textures of (-hotspotX + width)
maxY = max over textures of (-hotspotY + height)
buffer = (maxX - minX) × (maxY - minY)
```

Drawing then happens at `(-hotspotX - minX, -hotspotY - minY)`.

`anim.c` instead sizes the buffer to `max(width - hotspotX) × max(height - hotspotY)` anchored at
0, which crops sprites that extend into negative coordinates; the bounding box avoids that.

### 6.4 Draw order

There is no z-buffer: later `drawFrame` calls paint over earlier ones. Programs control the
order, so a host must execute them in program order.

---

## 7. Animation state in the context

The program keeps per-animation state in the TZO context. `<i>` is the animation index
(0-based), as defined by the tool that exported the program.

| Key | Type | Written by | Meaning |
|---|---|---|---|
| `anim_anim_<i>_index` | number | program | index of the currently visible frame inside animation `i` (0-based) |
| `anim_anim_<i>_active` | number | program **and host** | `0` = stopped, `1` = playing, `-1` = "draw the current frame once more, then stop" |
| `anim_anim_<i>_yy_direction` | number | program | `+1` / `-1`, only used by yo-yo animations |
| `anim_anim_<i>_tick` | number | program | how many ticks the current frame has been shown (used to honour durations) |
| `anim_anim_<i>_step` | number | program | ticks the current frame must be shown for (only present when frames have different durations) |

Rules:

* A host **must not** interpret these keys to draw — the program's draw blocks do that.
* A host **may** read them (to show animation state in a UI).
* A host **may** write `_active` to control playback:
  * `1` → start/continue,
  * `0` → stop (the frame disappears),
  * `-1` → let the current frame be drawn once more, then the program's epilogue sets it to `0`.
* Animations start with `_active = 1` for backgrounds and (by exporter default) `1` for the rest,
  or `0` when the exporter was told to start them stopped.

---

## 8. Program structure

A tzo-anim program has a canonical shape. Instructions are shown as `push`/`call` pseudo-code;
the real file is the JSON instruction list.

```
; ---- initialisation -------------------------------------------------
loadImage(hotspotY, hotspotX, "frame0.png")     ; one call per frame,
loadImage(...)                                  ; in .ani frame order
setContext 0        → anim_anim_0_index
setContext 1        → anim_anim_0_active
setContext 1        → anim_anim_0_yy_direction
setContext 0        → anim_anim_0_tick
...                                             ; for every animation
pause                          ; ← init hand-off (host sets up its buffer here)

; ---- mainAnimationLoop ----------------------------------------------
mainAnimationLoop:
  nop                          ; label target (also listed in labelMap)
  beginDraw
  <draw block for animation 0>
  <draw block for animation 1>
  ...
  endDraw
  <advance block for animation 0>
  <advance block for animation 1>
  ...
  <epilogue: every _active == -1 becomes 0>
  pause
  push "mainAnimationLoop"
  goto
```

One `run()` of the VM executes exactly **one tick**, i.e. one frame: it starts at
`mainAnimationLoop` and stops at the `pause` before the `goto`.

### Draw block

```
if anim_anim_i_active != 0 {
    if anim_anim_i_index == k {          ; one of these per frame k
        drawFrame(<texture index of frame k>)
    }
}
```

Background animations differ: their frames are static layers, so **all** of them are drawn
whenever the animation is active:

```
if anim_anim_i_active != 0 {
    drawFrame(t0); drawFrame(t1); ...     ; every frame of that animation
}
```

### Advance block

```
if anim_anim_i_active != 0 {
    anim_anim_i_tick += 1
    if anim_anim_i_tick >= <ticks needed> {
        anim_anim_i_tick = 0
        <advance the index, see §10>
    }
}
```

---

## 9. Timing

The host runs the VM at a fixed number of **ticks per second** (`fps`). `anim.c` runs it every
second vertical blank of a 60 Hz loop, i.e. **≈ 30 ticks/s**; the web player defaults to 30 and
lets the user change it.

Frame durations are compiled into the program as a number of ticks:

```
ticks = max(1, round(duration_seconds × fps))
```

The program compares its `_tick` counter against that number, so changing the host tick rate
scales the whole animation. If all frames of an animation have the same duration, one constant is
used; otherwise the program stores the current frame's value in `_step` before comparing.

The host itself does **not** need to know about durations.

---

## 10. Animation types

The exporter encodes the animation types of the UQM `.ani` extension as index progressions:

| Type | Index progression | Notes |
|---|---|---|
| `BACKGROUND` | never advances | all frames of the animation are drawn as static layers |
| `CIRCULAR` | `index = (index + 1) % n` | |
| `TALK` | same as `CIRCULAR` | |
| `RANDOM` | `index = randInt(n)` | `randInt(n)` yields `0 … n-1` |
| `YO_YO` | `index += direction`, direction flips at both ends | needs `_yy_direction` |
| `UNDEFINED` | treated as `CIRCULAR` | exporter warns |

Yo-yo advance, exactly as emitted:

```
if _yy_direction == 1  and index == n-1 → _yy_direction = -1
if _yy_direction == -1 and index == 0   → _yy_direction = 1
index = index + _yy_direction
```

---

## 11. Worked example (reference trace)

The repository contains a minimal program used as a test fixture:
[`tests/fixtures/sample/program.json`](https://github.com/jorisvddonk/tzo-anim-web/blob/main/tests/fixtures/sample/program.json).
The beginning of that file (abridged — 112 instructions in total, loop at index 21; the `/* … */` markers stand for omitted instructions and are not part of the file):

```json
{
  "labelMap": { "mainAnimationLoop": 21 },
  "programList": [
    { "type": "push-number-instruction", "value": 0 },
    { "type": "push-number-instruction", "value": 0 },
    { "type": "push-string-instruction", "value": "frame0.png" },
    { "type": "invoke-function-instruction", "functionName": "loadImage" },

    { "type": "push-number-instruction", "value": -2 },
    { "type": "push-number-instruction", "value": -4 },
    { "type": "push-string-instruction", "value": "frame1.png" },
    { "type": "invoke-function-instruction", "functionName": "loadImage" },

    { "type": "push-number-instruction", "value": 0 },
    { "type": "push-string-instruction", "value": "anim_anim_0_index" },
    { "type": "invoke-function-instruction", "functionName": "setContext" },
    /* ... active / yy_direction / tick ... */
    { "type": "invoke-function-instruction", "functionName": "pause" },

    { "type": "invoke-function-instruction", "functionName": "nop" },
    { "type": "invoke-function-instruction", "functionName": "beginDraw" },

    { "type": "push-string-instruction", "value": "anim_anim_0_active" },
    { "type": "invoke-function-instruction", "functionName": "getContext" },
    { "type": "push-number-instruction", "value": 0 },
    { "type": "invoke-function-instruction", "functionName": "eq" },
    { "type": "invoke-function-instruction", "functionName": "not" },
    { "type": "invoke-function-instruction", "functionName": "jgz" },
    { "type": "invoke-function-instruction", "functionName": "{" },
    { "type": "push-string-instruction", "value": "anim_anim_0_index" },
    { "type": "invoke-function-instruction", "functionName": "getContext" },
    { "type": "push-number-instruction", "value": 0 },
    { "type": "invoke-function-instruction", "functionName": "eq" },
    { "type": "invoke-function-instruction", "functionName": "jgz" },
    { "type": "invoke-function-instruction", "functionName": "{" },
    { "type": "push-number-instruction", "value": 0 },
    { "type": "invoke-function-instruction", "functionName": "drawFrame" },
    { "type": "invoke-function-instruction", "functionName": "}" },
    { "type": "invoke-function-instruction", "functionName": "}" },
    /* ... frame 1 draw block, endDraw, advance block, epilogue, pause, goto ... */
  ]
}
```

It has two 8×8 textures and one `CIRCULAR` animation with two frames, advancing every 2 ticks:

| Texture | Hotspot | Content |
|---|---|---|
| `frame0.png` (index 0) | `(0, 0)` | 4×4 red block in the top-left |
| `frame1.png` (index 1) | `(-4, -2)` | solid green |

Initialisation state written by the program:

```json
{ "anim_anim_0_index": 0, "anim_anim_0_active": 1, "anim_anim_0_yy_direction": 1, "anim_anim_0_tick": 0 }
```

Frame buffer: `12 × 10` (texture 0 at `(0,0)`, texture 1 at `(4,2)`).

| Tick | `drawFrame` calls | `_index` after tick | `_tick` after tick |
|---|---|---|---|
| 1 | `0` | 0 | 1 |
| 2 | `0` | 1 | 0 |
| 3 | `1` | 1 | 1 |
| 4 | `1` | 0 | 0 |
| 5 | `0` | 0 | 1 |
| 6 | `0` | 1 | 0 |

Note how the index advances *after* drawing: the frame that is drawn is the one from the start of
the tick. After tick 3 the pixel at `(4, 2)` is green; it stays green when later frames no longer
cover it, because the buffer is persistent.

If your implementation reproduces this table, it implements the format correctly.

---

## 12. Conformance checklist

- [ ] Parse `programList` and `labelMap`; ignore `comment` and instruction-level `label` when the
      label also exists in `labelMap`.
- [ ] Run the initialisation block once and stop at its `pause`.
- [ ] `loadImage` pops `path`, `hotspotX`, `hotspotY` (in that order) and assigns texture indices
      in call order.
- [ ] `drawFrame(n)` blits texture `n` at `(-hotspotX, -hotspotY)` with alpha, clipped to the buffer.
- [ ] The frame buffer persists between frames; `endDraw` presents it.
- [ ] One `run()` = one tick; the loop ends with `pause` + `goto mainAnimationLoop`.
- [ ] Animation state lives in the `anim_anim_*` context keys; the host only reads them (and may
      write `_active`).
- [ ] `_active = -1` draws one more frame, then becomes `0`.
- [ ] The reference trace in §11 matches.

---

## 13. Implementation notes and pitfalls

* **`{` / `}` and function names.** The TypeScript reference VM implements `{` by scanning the
  program list for the *function named* `openBrace`. Bundlers rename functions
  (`openBrace` → `openBrace2`), which breaks every `if` block. The web player restores those names
  after loading a program (`ensureBraceFunctionNames` in `src/player.js`). Other implementations
  should identify block boundaries structurally instead.
* **Texture limit.** `anim.c` has `MAX_TEXTURES 128`; larger projects need a bigger limit. The web
  player has no limit.
* **Alpha.** See §6.2 — `anim.c` ignores alpha and draws transparent pixels as palette entry 0.
* **Numbers are floats.** Comparisons (`eq`, `lt`, `gt`) are numeric, so `1` equals `1.0`.
* **`randInt(n)`** must return an integer in `[0, n-1]`.
* **Programs are self-contained.** Do not hard-code animation behaviour in the host: a program may
  use any combination of the context keys, or none at all (a pure slideshow is legal).
* **Missing content.** Prefer placeholders/warnings over aborting; `anim.c` exits, the web player
  draws a 1×1 transparent placeholder and logs the path.

---

## 14. References

* Core TZO specification and reference VM: <https://github.com/jorisvddonk/tzo>
* C implementation with the `anim.c` animation host: <https://github.com/jorisvddonk/tzo-c>
* Web player (this repository): <https://github.com/jorisvddonk/tzo-anim-web>
* UQM `.ani` extension that these animations come from:
  <https://github.com/jorisvddonk/uqmanimationtool/blob/main/README_EXTENSIONSPECS.txt>
