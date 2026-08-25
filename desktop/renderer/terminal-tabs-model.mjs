export class TerminalTabsModel {
  constructor() {
    this.terminals = new Map();
    this.activeId = null;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(eventData) {
    for (const listener of this.listeners) listener(eventData);
  }

  addTerminal(id, metadata, terminal, fit, container, dispose) {
    if (this.terminals.has(id)) return false;
    this.terminals.set(id, {
      id,
      metadata,
      terminal,
      fit,
      container,
      dispose,
      sequence: metadata.sequence || 0,
      outputCursor: metadata.outputCursor ?? metadata.outputSequence ?? 0,
    });
    if (!this.activeId && !metadata.hidden) {
      this.activeId = id;
    }
    this.notify({ type: 'add', id });
    return true;
  }

  updateSequence(id, sequence) {
    const t = this.terminals.get(id);
    if (t && sequence > t.sequence) {
      t.sequence = sequence;
      return true;
    }
    return false;
  }

  updateOutputSequence(id, sequence) {
    const terminal = this.terminals.get(id);
    if (!terminal || sequence <= terminal.outputCursor) return false;
    terminal.outputCursor = sequence;
    return true;
  }

  updateMetadata(id, update) {
    const t = this.terminals.get(id);
    if (t) {
      if (update.sequence !== undefined) {
        if (update.sequence < t.sequence) return false;
        t.sequence = update.sequence;
      }
      t.metadata = { ...t.metadata, ...update };
      if (t.metadata.hidden && this.activeId === id) this._selectFallback();
      this.notify({ type: 'update', id });
      return true;
    }
    return false;
  }

  setHidden(id, hidden) {
    return this.updateMetadata(id, { hidden });
  }

  removeTerminal(id) {
    const t = this.terminals.get(id);
    if (t) {
      this.terminals.delete(id);
      if (this.activeId === id) {
        this._selectFallback();
      }
      this.notify({ type: 'remove', id, removed: t });
    }
  }

  _selectFallback() {
    const all = this.getAll();
    const running = all.filter(
      (terminal) =>
        !terminal.metadata.hidden &&
        ['starting', 'running', 'waiting', 'stopping'].includes(
          terminal.metadata.status,
        ),
    );
    if (running.length > 0) {
      this.activeId = running[running.length - 1].id;
    } else {
      const visible = all.filter((terminal) => !terminal.metadata.hidden);
      this.activeId =
        visible.length > 0 ? visible[visible.length - 1].id : null;
    }
  }

  selectTerminal(id) {
    const terminal = this.terminals.get(id);
    if (terminal && !terminal.metadata.hidden) {
      this.activeId = id;
      this.notify({ type: 'select', id });
      return true;
    }
    return false;
  }

  get(id) {
    return this.terminals.get(id);
  }

  getActive() {
    return this.activeId ? this.terminals.get(this.activeId) : null;
  }

  getAll() {
    return Array.from(this.terminals.values());
  }

  counts() {
    let running = 0;
    let hidden = 0;
    let total = 0;
    for (const t of this.terminals.values()) {
      total++;
      if (t.metadata.hidden) {
        hidden++;
      }
      if (
        ['starting', 'running', 'waiting', 'stopping'].includes(
          t.metadata.status,
        )
      ) {
        running++;
      }
    }
    return { running, hidden, total };
  }

  reconcileInventory(inventory, factory) {
    const inventoriedIds = new Set(inventory.map((terminal) => terminal.id));
    for (const id of this.terminals.keys()) {
      if (!inventoriedIds.has(id)) this.removeTerminal(id);
    }
    const added = [];
    for (const item of inventory) {
      const t = this.terminals.get(item.id);
      if (t) {
        if (item.sequence >= t.sequence) {
          t.sequence = item.sequence;
          t.metadata = { ...t.metadata, ...item };
        }
      } else {
        added.push(item);
      }
    }

    if (added.length > 0 && factory) {
      for (const item of added) {
        factory(item);
      }
    }

    if (!this.terminals.has(this.activeId)) {
      this._selectFallback();
    }

    this.notify({ type: 'reconcile' });
  }
}
