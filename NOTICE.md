# Licenses

Interactive Method code and instructions are distributed under the MIT license. See [LICENSE](LICENSE).

The video runtime bundles the [undici](https://github.com/nodejs/undici) HTTP client under the MIT license. Its license is in `runtime/licenses/`.

The document site is generated with [VuePress](https://vuepress.vuejs.org/), its default theme, the official [markdown-chart plugin](https://ecosystem.vuejs.press/plugins/markdown/markdown-chart.html) and [Mermaid](https://mermaid.js.org/). These packages and their required components retain their respective licenses. Pinned package manifests are in `runtime/vuepress-toolchain/`. Dependency license texts are retained in the installed toolchain and copied into each site's `THIRD-PARTY-NOTICES.txt`. Generated assets also retain bundler legal comments. The build helper uses Marked under the MIT license, retained in `runtime/licenses/html-renderer-NOTICES.txt`.

FFmpeg is distributed as a separate executable through [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static). Its licenses and build information are kept in `runtime/licenses/`. The file `runtime/build.json` records component versions and hashes.

Node.js is a prerequisite and is not included. The agent manages the VuePress build toolchain when generating document sites.

Videos, transcripts and captured frames retain their authors' rights. They are excluded from the plugin package.
