export class LatestRequestGate {
  constructor() {
    this.revision = 0;
  }

  issue(scope) {
    return { revision: ++this.revision, scope };
  }

  accepts(ticket, scope = ticket?.scope) {
    return Boolean(
      ticket && ticket.revision === this.revision && ticket.scope === scope,
    );
  }

  invalidate() {
    this.revision += 1;
  }
}
