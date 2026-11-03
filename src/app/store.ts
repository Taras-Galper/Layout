// The plan being edited, the selection, undo / redo and autosave.
import type { Level, Plan, Vec2 } from '../model/plan';

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'room'; id: string }
  /** A closed room without a name yet, picked by a point inside it. */
  | { kind: 'loop'; at: Vec2 };

/** live: a drag is in progress; change: an edit finished; load: a different plan; selection: only the selection. */
export type StoreEvent = 'live' | 'change' | 'load' | 'selection';

const AUTOSAVE_KEY = 'layout.autosave.v1';
const MAX_UNDO = 200;

export class Store {
  plan: Plan;
  levelIndex = 0;
  selection: Selection | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pending: string | null = null;
  private listeners: ((e: StoreEvent) => void)[] = [];
  private saveTimer = 0;
  /** Bumped on every edit, so views can tell whether they are up to date. */
  revision = 0;

  constructor(plan: Plan) {
    this.plan = plan;
  }

  get level(): Level {
    return this.plan.levels[this.levelIndex];
  }

  on(fn: (e: StoreEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: StoreEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  load(plan: Plan): void {
    this.plan = plan;
    this.levelIndex = 0;
    this.selection = null;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.revision++;
    this.emit('load');
    this.scheduleSave();
  }

  /** One complete edit. Returns whatever fn returns. */
  edit<T>(fn: (level: Level, plan: Plan) => T): T {
    const before = JSON.stringify(this.plan);
    const result = fn(this.level, this.plan);
    this.commitFrom(before);
    return result;
  }

  /** Start of a drag: later live() calls change the plan, end() records one undo step for all of them. */
  begin(): void {
    if (this.pending === null) this.pending = JSON.stringify(this.plan);
  }

  live(fn: (level: Level, plan: Plan) => void): void {
    if (this.pending === null) this.begin();
    fn(this.level, this.plan);
    this.revision++;
    this.emit('live');
  }

  end(fn?: (level: Level, plan: Plan) => void): void {
    if (this.pending === null) return;
    if (fn) fn(this.level, this.plan);
    const before = this.pending;
    this.pending = null;
    this.commitFrom(before);
  }

  /** Throw away a drag in progress. */
  cancel(): void {
    if (this.pending === null) return;
    this.plan = JSON.parse(this.pending);
    this.pending = null;
    this.revision++;
    this.emit('change');
  }

  private commitFrom(before: string): void {
    if (before === JSON.stringify(this.plan)) {
      this.emit('selection');
      return;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.validateSelection();
    this.revision++;
    this.emit('change');
    this.scheduleSave();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.plan));
    this.plan = JSON.parse(prev);
    this.afterHistory();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.plan));
    this.plan = JSON.parse(next);
    this.afterHistory();
  }

  private afterHistory(): void {
    this.levelIndex = Math.min(this.levelIndex, this.plan.levels.length - 1);
    this.validateSelection();
    this.revision++;
    this.emit('change');
    this.scheduleSave();
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.emit('selection');
  }

  isSelected(kind: Selection['kind'], id: string): boolean {
    const s = this.selection;
    return !!s && s.kind === kind && 'id' in s && s.id === id;
  }

  /** Drop the selection when what it points at no longer exists. */
  private validateSelection(): void {
    const s = this.selection;
    if (!s || s.kind === 'loop') return;
    const l = this.level;
    const lists = { node: l.nodes, wall: l.walls, opening: l.openings, room: l.rooms };
    if (!lists[s.kind].some((x) => x.id === s.id)) this.selection = null;
  }

  // ---------------------------------------------------------------- autosave

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.plan));
      } catch {
        /* storage full or unavailable: autosave is a convenience */
      }
    }, 400);
  }

  static restore(): Plan | null {
    try {
      const s = localStorage.getItem(AUTOSAVE_KEY);
      return s ? (JSON.parse(s) as Plan) : null;
    } catch {
      return null;
    }
  }
}
