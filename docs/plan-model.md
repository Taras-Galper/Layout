# Plan model (version 1)

The one format every part of the app shares: importers write it, the 2D editor edits it, the 3D
builder reads it. Machine-readable schema: `schema/plan.schema.json`. TypeScript types:
`src/model/plan.ts`.

## Conventions

- Units are **metres**. Angles are degrees.
- Plan coordinates: **x to the right (east on the sheet), y up the sheet (north on the sheet)**.
  In 3D, plan `(x, y)` becomes `(x, elevation, -y)` with y up.
- IDs are strings, unique within their level.
- Room types and element kinds are language-neutral codes. Display names come from translations
  unless the plan gives a custom `name`.

## Structure

```
Plan
├── schema: "walkabout.plan", version: 1, units: "m"
├── name
├── north?            angle of true north, clockwise from plan +y (for sun direction later)
├── source?           where the plan came from (file, page, scale, drawing→plan transform)
└── levels[]          one for a flat; several for duplexes and houses
    ├── id, name
    ├── elevation     finished floor height above building zero (m)
    ├── height        default floor-to-ceiling height of walls on this level (m)
    ├── slabThickness?
    ├── nodes[]       { id, x, y }                       shared wall end points
    ├── walls[]       { id, a, b, thickness, kind, height?, confidence? }
    ├── openings[]    { id, wall, offset, width, kind, sill?, head?, hinge?, swing?, confidence? }
    └── rooms[]       { id, type, name?, at: [x, y], floor?, confidence? }
```

### Walls

A wall is a **centre-line** from node `a` to node `b` with a `thickness`. Walls meet only at shared
nodes, so the walls of a level form a planar graph. A wall that another wall meets in its middle is
split into two walls at that point (a T-junction is a node with three walls).

`kind`:

| kind | meaning |
|---|---|
| `exterior` | outer wall of the building |
| `interior` | normal inside wall |
| `partition` | thin non-load-bearing wall |
| `structural` | thick load-bearing or protected-room wall |
| `railing` | balcony parapet or rail; low, defaults to 1.05 m |
| `virtual` | invisible room separator (open-plan kitchen / living); no geometry, no collision |

`height` overrides the level height for this wall.

### Openings

An opening sits on one wall. `offset` is the distance in metres from node `a` along the wall to the
**centre** of the opening; `width` is the clear width.

| kind | default sill | default head | notes |
|---|---|---|---|
| `door` | 0 | 2.1 | leaf, `hinge` and `swing` apply |
| `entry` | 0 | 2.1 | front door |
| `window` | 0.9 | 2.2 | |
| `slider` | 0 | 2.4 | sliding glass door |
| `passage` | 0 | 2.1 | opening without a door |

`hinge`: `start` (the jamb nearer node `a`) or `end`. `swing`: `left` or `right` — the side of the wall
(looking from `a` to `b`) the leaf opens into.

### Rooms

Room shapes are **not stored**: they are the closed loops of the wall graph, computed every time the
plan changes. A room entry is a tag: a point `at` inside the loop plus its `type`, optional custom
`name` and floor material. Loops without a tag are shown as unnamed rooms.

Room types: `living`, `kitchen`, `dining`, `bedroom`, `bathroom`, `wc`, `laundry`, `storage`,
`closet`, `hallway`, `entry`, `office`, `safe_room`, `balcony`, `other`.

### Confidence

Importers set `confidence` (0–1) on what they detected so the editor can highlight weak spots.
Hand-made elements leave it out.

## Planned extensions (not in version 1)

These are reserved so later features add fields instead of changing existing ones.

- **Multi-level**: `stairs[]` on the plan connecting two level IDs with a footprint and run direction;
  `voids[]` on a level (stair holes, double-height spaces).
- **Private houses**: `roofs[]`, `site` (terrain outline, ground level, garden areas), exterior
  materials.
- **Furniture**: `items[]` per level referencing catalog IDs with position, rotation and material.
- **Materials**: per-room and per-wall-face finishes.
- Any change that breaks old files raises `version`, and the loader migrates older versions forward.
