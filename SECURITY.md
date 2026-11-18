# Security policy

Report suspected vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/curlewlabs-com/stale-translations/security/advisories/new).
Include the affected release or source revision, the runtime and its version,
the input that shows the problem (a sidecar file and the catalog values, with
anything private removed), and what you observed against what you expected.

The fingerprint answers "did this text change?" and nothing more. It is a
truncated hash chosen for a readable diff, not for collision resistance, and
the sidecar is a file whoever can edit your catalogs can also edit, so neither
is a security boundary. A report that a malformed sidecar is read as fresh
instead of refused is a bug worth reporting, and an ordinary issue is fine for
it.

Curlew Labs maintains this repository; Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) is the release
and security contact through GitHub. Reports are reviewed on a best-effort basis
without a guaranteed response time. Fixes target the latest release; older
releases have no promised backport.
