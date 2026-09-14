# Vendored binaries

## rg.exe — ripgrep 15.0.0 (rev 3a612f88b8, features: +pcre2, x86_64-pc-windows-msvc)

Prebuilt release downloaded from the official ripgrep GitHub releases
(https://github.com/BurntSushi/ripgrep/releases). Used by the `search_files`
tool as an optional accelerator; the built-in scanner is the fallback.

ripgrep is dual-licensed under the Unlicense or the MIT License (at your
option), copyright Andrew Gallant and the ripgrep contributors. Both texts are
included next to the binary -- `UNLICENSE` and `LICENSE-MIT` -- because MIT
requires the notice to travel with the distribution, and `vendor/` is in this
package's `files` list, so the binary ships to every installer. Upstream:
https://github.com/BurntSushi/ripgrep/blob/master/COPYING.

(An earlier revision of this note said "MIT or Apache 2.0". That is the common
Rust pairing but not what ripgrep uses; corrected before the repository went
public.)

Replace this binary by downloading a new release and keeping this note
in sync with the version banner.
