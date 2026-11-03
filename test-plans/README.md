# Test plans

Real floor plans used to test and score the importers (milestones 3–6). Every importer change is
run against all of them.

**The plan files here are not committed to git** (see `.gitignore`): developer plans and plans of
people's homes are often private. Only this README and the corrected `*.truth.json` files are
committed. To share a plan publicly anyway, add it with `git add -f`.

## What to collect (15–20 in all)

| Kind | Aim for | Examples |
|---|---|---|
| DXF | 3–4 | from AutoCAD, from a PDF conversion, with and without layers |
| DWG | 2–3 | architect / developer drawings |
| Vector PDF | 4–5 | developer sales plans, sheets with several plans, legends, title blocks |
| Scanned PDF | 2–3 | printed plans scanned at the office |
| Phone photo | 2–3 | straight and at an angle, with shadows or glare |
| Hand sketch | 1–2 | drawn on paper, with written dimensions |

Variety matters more than count: different countries and languages, flats and houses, small and large,
angled walls, open-plan kitchens, plans with drawn furniture.

## Naming

`<kind>-<short-name>.<ext>`, for example `pdf-dira.pdf`, `dwg-haifa-tower.dwg`, `photo-studio-angled.jpg`.

Later, each plan gets a corrected version made in the 2D editor (milestone 2):
`<same name>.truth.json`, which is what the importers are scored against.

## Notes per plan

Add a line here for anything worth knowing about a plan: its real scale, a known room size to check
against, which page of a PDF is the plan, what makes it hard.

| File | Notes |
|---|---|
| `pdf-dira.pdf` | |
