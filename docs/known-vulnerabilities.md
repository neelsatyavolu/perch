# Known vulnerabilities

Before each release, `perch-build release` runs `osv-scanner` on the release SBOM. It refuses to publish while `osv-scanner` reports a vulnerability that is not listed in the table below.

List a vulnerability here only when it does not affect Perch, or when no fixed version exists yet and the risk is understood. Each row needs the id `osv-scanner` printed (a GHSA, CVE or other OSV id; an alias works too), the package, the reason, and the date it was added as YYYY-MM-DD. Remove the row once the dependency is updated.

Chromium's own third-party code is not checked here. It is covered by moving to each Chromium stable release within 72 hours (see `SECURITY.md`).

| ID | Package | Reason | Date |
|---|---|---|---|
