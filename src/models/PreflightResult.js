export class PreflightResult {
  constructor(ok = true, checks = []) {
    this.ok = ok;
    this.checks = checks;
  }

  static fromResults(results) {
    return new PreflightResult(results.ok, results.checks);
  }
}
