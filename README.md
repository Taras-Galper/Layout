# Layout

Turn a floor plan into a 3D model you can walk through and, later, furnish.

This is **milestone 1**: the plan model and the 3D shell. A plan file (JSON, see
[`docs/plan-model.md`](docs/plan-model.md)) becomes walls with clean joints, doors, windows,
sliding doors, floors, ceilings and a floor slab, lit in real time (sky, sun with soft shadows,
sky-based environment light, ambient occlusion). Importing CAD files, PDFs and images comes in later
milestones — see [`docs/PLAN.md`](docs/PLAN.md).

## Run it

Needs [Node.js](https://nodejs.org/) 20 or newer.

```
npm install
npm run dev
```

Then open http://localhost:5173. Other commands:

| | |
|---|---|
| `npm test` | model tests (room detection, wall joints, validation) |
| `npm run typecheck` | TypeScript check |
| `npm run build` | production build into `dist/` |

## Using it

- **Plan**: pick a sample, or **Open file…** / drop a plan `.json` onto the page.
  `?plan=studio.json` in the address opens a sample directly.
- **Cutaway** drops the walls facing the camera, **Walls up** shows them all, **Walls down** lowers
  them all.
- Drag to turn, right-drag to pan, scroll to zoom. Click a room name to fly to it.
- **Walk**: double-click a floor (or press Walk). Drag to look, W A S D or arrows to move, Shift to
  hurry, Esc to leave. Walls and windows block you; doors and passages don't.
- **Time of day** moves the sun. **Quality** switches ambient occlusion, shadow resolution and pixel
  density (picked automatically per device).
- The side panel lists the rooms with their areas inside the walls, and any problems found in the
  plan.

## Project layout

| | |
|---|---|
| `docs/PLAN.md` | decisions, architecture, milestones |
| `docs/plan-model.md`, `schema/plan.schema.json` | the plan format every part shares |
| `src/model/` | plan types, validation, room detection, wall outlines with joints |
| `src/three/` | 3D shell builder, door / window models, lighting, view modes |
| `src/ui/`, `src/main.ts` | the page |
| `src/i18n/` | all on-screen text (English); add a JSON file per language |
| `public/plans/` | sample plans |
| `test-plans/` | real plans for testing the importers (files stay local, see its README) |
| `tests/` | model tests |
