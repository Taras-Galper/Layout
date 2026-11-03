# Layout — project plan

A web app that turns a floor plan (CAD file, PDF or a photo of a drawing) into a 3D model of the
space, which the user corrects, walks through and later furnishes like in The Sims.
Reference for look and feel: the Flat13 project. Reference for scope: Coohom.

## Decisions so far

| Topic | Decision |
|---|---|
| Light | Real-time only. No baking of any kind, per flat or per model. |
| Look | Realistic but light: realism from light and materials, not polygon count. |
| Language | English UI. Every string goes through a translation key (`t('…')`) so other languages, including right-to-left ones, can be added later without rewrites. Room types are language-neutral codes. |
| Plans in other languages | The importer reads whatever language is printed on the plan and maps it to room codes. |
| Building scope | Single-level apartments first. The data model is multi-level from day one (levels with elevations) so duplexes and private houses are an extension, not a rewrite. |
| Where it runs | Locally while developing. Hosting decided later. |
| Furniture | Later, after the import → 3D shell path works. |

## Shape of the app

```
DXF / DWG / PDF / image ──► importer ──► PLAN JSON ──► 2D editor (fix / draw) ──► 3D shell ──► furnish ──► render
                                            ▲                                       │
                                            └──────────── one shared model ─────────┘
```

Everything reads and writes one plan format (`docs/plan-model.md`, `schema/plan.schema.json`).
Nothing downstream knows where a plan came from.

## Import pipeline (milestones 3–6)

1. **Read the input** into vector shapes (lines, arcs, hatches, text with positions) or a clean image.
   - DXF: ezdxf, blocks exploded, layer names used as hints.
   - DWG: converted to DXF (ODA File Converter), then the DXF path.
   - Vector PDF: PyMuPDF paths + text.
   - Scanned PDF / photo: rendered at 300 dpi, perspective straightened, cleaned, thresholded.
2. **Scale**: DXF units → dimension numbers on dimension lines → printed room sizes matched to
   detected rooms → standard door width as a sanity check. A two-click calibration is always available.
3. **Walls**: parallel line pairs at wall spacing, hatched / filled regions (vector); a wall mask from
   thick strokes (raster). Mask → centre-lines with thickness → snap to main angles, merge, close junctions.
4. **Doors and windows**: arc + gap = door; gap crossed by thin parallel lines = window; overlapping
   lines = slider. Each attaches to its nearest wall.
5. **Rooms**: closed loops of the wall graph; labels from text inside each loop.
6. **Claude as reader and checker** (not geometry maker): reads labels and dimensions in any language,
   finds the plan on a busy sheet, tells drawn furniture from walls, and reviews the result overlaid on
   the original. One or two calls per import.

Licensing note: most open floor-plan detection models are trained on CubiCasa5K (non-commercial).
Start with classical computer vision + Claude; train our own model later on plans corrected in our editor.

## 2D editor (milestone 2, done)

Drawing underneath at the right scale; walls as draggable centre-lines with snapping; add / delete /
split walls; doors and windows slide along walls with width handles and swing flip; rooms recalculate
on every change; low-confidence items highlighted; undo / redo; draw-from-scratch mode; split 2D | 3D
view with live updates. Built: tracing over an image or PDF with two-point scale calibration,
wall / room-box / door / window / slider / opening / room-name tools, snapping, typed lengths,
properties panel, autosave. Not yet: pinch zoom on touch screens, rotating the drawing, multi-level
editing UI, unit settings (m / cm / ft). Built before the importers: every importer produces a draft the editor fixes,
and the editor makes the "truth" files for the test set.

## 3D shell (milestone 1, done)

- Walls from centre-lines with clean mitred joints; openings built by splitting the wall into pieces
  below the sill and above the head (no CSG).
- Parametric door, window and slider frames; floors and ceilings from room shapes.
- Real-time light: sky + sun with soft shadows, environment lighting from the same sky,
  screen-space ambient occlusion (N8AO), AgX tone mapping, quality tiers by device.
- Views: Sims-style cutaway (walls facing the camera drop), walls up, walls down, walk mode with
  collision.

## Stack

- Front end: Vite + TypeScript + three.js. 2D editor in SVG or Canvas.
- Import service (from milestone 3): Python FastAPI with ezdxf, PyMuPDF, OpenCV, shapely,
  ODA converter, Claude API.
- Plans saved as JSON files locally at first.

## Test set and scoring

15–20 real plans of different kinds (DXF, DWG, developer PDFs, scans, phone photos, a hand sketch),
each with a corrected truth file made in the editor. Every importer change is scored on wall overlap,
doors and windows found, rooms and labels correct, scale error, and minutes of manual fixing.

## Milestones

| # | Milestone | Demo at the end | Size | Status |
|---|---|---|---|---|
| 1 | Plan model + 3D shell builder | A plan file renders as a walkable, lit 3D shell with cutaway | M | done |
| 2 | 2D editor | Draw a flat from scratch and see it live in 3D | L | done |
| 3 | DXF + DWG import | CAD files open as editable plans | M | next |
| 4 | PDF import, vector and scanned | Developer PDFs open | M |  |
| 5 | Image and photo import | A phone photo of a plan becomes a draft | L |  |
| 6 | Claude reading and check pass, tuning on the test set | Labels and scale automatic, problem spots highlighted | M |  |

Later: furniture catalog and placement, materials and moods, saving and sharing, accounts and hosting,
AI / path-traced final renders, multi-level buildings and private houses, localisation.
