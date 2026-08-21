# SnoreToast binary provenance

`snoretoast-x64.exe` is SnoreToast 0.7.0 (KDE project, LGPL-3.0; see `LICENSE`),
a small Windows toast-notification CLI. CMD Riker invokes it from the detached
Lead host to raise Owner toasts under the registered "CMD Riker" app identity —
no PowerShell involved.

KDE stopped publishing prebuilt SnoreToast binaries, so this copy was extracted
from the `node-notifier` npm package, the de-facto distribution channel used by
jest, webpack, and most Node desktop tooling.

- Source tarball: `https://registry.npmjs.org/node-notifier/-/node-notifier-10.0.1.tgz`
- Tarball SHA-256: `5e75d1bb41696f3334481ec083204335e519920d292855cb6afb6b0e2d9afe9b`
- Extracted file: `package/vendor/snoreToast/snoretoast-x64.exe`
- Binary SHA-256: `42d20792498514562cfd6fd8221b4abb59229e893073fc59fbfc83f884a2401b`
- Extracted: 2026-08-21

The build script copies it into the release bundle as `tools/snoretoast-x64.exe`,
where the hashed manifest pins these exact bytes like every other bundle file.
