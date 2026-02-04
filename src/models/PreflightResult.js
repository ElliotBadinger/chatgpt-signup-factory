export class PreflightResult {
  constructor() {
    this.checks = [];
  }

  addCheck(name, ok, message = '') {
    this.checks.push({ name, ok, message });
  }

  get ok() {
    return this.checks.every(c => c.ok);
  }

  get issues() {
    return this.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.message}`);
  }
}
