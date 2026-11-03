# Layout

Turn a floor plan into a 3D model you can walk through and, later, furnish.

**Where it stands:** milestones 1 and 2 of [`docs/PLAN.md`](docs/PLAN.md).

- **Plan editor (2D)**: draw a flat from scratch, or trace one over an image or PDF of its plan.
  Walls, doors, windows, sliding doors, openings and room names; rooms are found automatically.
- **3D model**, updated live as you draw: walls with clean joints, door and window models, floors,
  ceilings, real-time light (sky, sun with soft shadows, ambient occlusion), cutaway and walk modes.

Automatic import of CAD files, PDFs and photos comes next (milestones 3–6).

## Run it

Needs [Node.js](https://nodejs.org/) 20 or newer.

```
npm install
npm run dev
```

Then open http://localhost:5173. Other commands:

| | |
|---|---|
| `npm test` | model tests (editing, room detection, wall joints, validation) |
| `npm run typecheck` | TypeScript check |
| `npm run build` | production build into `dist/` |

## Using it

**Top bar**: pick a sample or your autosaved plan, **New**, **Open…** (a plan `.json`, or an image /
PDF to trace — or drop a file on the page), **Save** (downloads the plan as `.json`), undo / redo,
and the layout: **Plan**, **Split** (plan and 3D side by side) or **3D**.

**Tracing a drawing**

1. **Open…** an image or PDF of the plan (or **Drawing → Add…** to put one under the current plan).
2. **Scale**: click both ends of something you know the length of — a dimension line, a wall —
   and type the real distance (`3.2` = metres, `320` = centimetres). **Move** drags the drawing,
   **Fade** and **Show** change how strongly it shows.
3. Trace with **Room box** (drag a rectangle) and **Wall** (click corner to corner), then put doors
   and windows on the walls and name the rooms.

**Tools** (keyboard shortcut in brackets)

| Tool | |
|---|---|
| Select (V) | click to select; drag points, walls (sideways), openings and room names; drag empty space to pan; Delete removes |
| Wall (W) | click corner to corner; type a length while drawing; double-click, Enter or right-click ends; snaps to points, walls, straight angles and lines through other points (Alt turns snapping off) |
| Room box (R) | four walls around a rectangle |
| Door (D), Window (N), Slider (S), Opening (O) | click a wall; doors open towards the side you click on |
| Room name (T) | click inside a closed room |
| Fit (F) | show the whole plan |

Walls that cross or end on another wall join it automatically. Scroll to zoom; middle- or
right-drag (or Space + drag) pans in every tool. Ctrl+Z / Ctrl+Shift+Z undo and redo.

The **side panel** shows the selection's properties (type, thickness, length, widths, sill and top
heights, hinge and swing; with nothing selected, the plan's name, ceiling height and north), the
rooms with their areas inside the walls, and any problems found.

The plan is **autosaved in the browser** (and the drawing under it). Use **Save** to keep a file.

**3D**: drag to turn, right-drag to pan, scroll to zoom, double-click a floor to walk there (W A S D
or arrows, Shift to hurry, Esc to leave). **Cutaway** drops the walls facing the camera.

## Project layout

| | |
|---|---|
| `docs/PLAN.md` | decisions, architecture, milestones |
| `docs/plan-model.md`, `schema/plan.schema.json` | the plan format every part shares |
| `src/model/` | plan types, editing operations, validation, room detection, wall outlines with joints |
| `src/editor/`, `src/app/` | the 2D editor, tools, snapping, drawing underlay, properties; plan state with undo |
| `src/three/` | 3D shell builder, door / window models, lighting, view modes |
| `src/ui/`, `src/main.ts` | the page |
| `src/i18n/` | all on-screen text (English); add a JSON file per language |
| `public/plans/` | sample plans |
| `test-plans/` | real plans for testing the importers (files stay local, see its README) |
| `tests/` | model tests |
