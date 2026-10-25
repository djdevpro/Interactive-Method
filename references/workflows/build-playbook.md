# Build and open the VuePress playbook

This internal workflow follows the user's request to deepen and the consolidation of agent results. It does not run automatically on the initial video link.

Use [playbook.md](../../templates/playbook.md) as the editable source. Write every reader-facing section, heading, caption and diagram label in `session.language`. The finished reader is a genuine VuePress site, opened through local HTTP in the harness browser, with the Markdown retained as its editable source. The agent handles the framework and build commands.

1. Define the practical outcome, conditions and prerequisites. Preserve the author's actual method and clearly identify any proposed adaptation.
2. Develop a consistent worked example across steps, labeling synthetic inputs and assumptions. A proposal is not an executed result.
3. For each step, explain purpose, inputs, concrete actions, decisions, expected output, checks and troubleshooting. Cite precise transcript passages and inspected screenshots beside the relevant explanation.
4. Reuse the useful stage 1 captures. Incorporate later captures only when they clarify a specific issue. Keep provenance, timestamps, captions and evidence IDs. Write captions as visible Markdown paragraphs beneath images in addition to their accessibility alt text.
5. Include the neutral Mermaid overview and any useful neutral step diagrams. Preserve unsupported questions and limitations; do not invent missing method steps or add unrequested supplementary sources.
6. Build the Markdown with the VuePress helper. It enables Mermaid through the official `@vuepress/plugin-markdown-chart` plugin. Keep Mermaid in fenced `mermaid` blocks in the source and use the neutral theme. Do not substitute a custom HTML shell or a standalone Mermaid script for the requested VuePress integration.

```sh
node "<PLUGIN>/runtime/playbook.mjs" render "<WORKSPACE>/playbook.md" --out "<WORKSPACE>/playbook.html" --language "<USER_LANGUAGE>"
```

Use the session language, for example `fr`, and serve the result through the bundled local server. VuePress module assets need HTTP; a `file://` page is not the supported preview.

The build writes `playbook-site/` and a `playbook.html` launcher, with generated build inputs in `.vuepress-source/playbook/`. Keep `playbook.md` as the source to edit and retain the entire site directory. The helper installs its pinned toolchain in an external user cache on first use; npm and network access are needed for that initial setup, not for reading the built site.

```sh
node "<PLUGIN>/runtime/playbook.mjs" serve "<WORKSPACE>" --port 0
```

Use the localhost URL returned by the server and open `playbook.html` through the host's browser-opening tool. In Codex, use `open_in_codex` with a browser target. Keep the server process available while the preview is in use and retain its handle for later cleanup. Do not silently substitute a shell-launched external browser for the requested harness browser.

7. Inspect the rendered page. Verify the requested language, headings, navigation, readable code and tables, loaded screenshots, and actual Mermaid SVG output with the neutral theme. Check a narrow viewport and ensure links point to intended evidence. A successful build alone does not prove successful browser rendering.
8. Complete the [audit](../quality-checks.md), mark browser or rendering limitations honestly, and deliver the opened page with the Markdown source link.

If the harness cannot open or inspect a browser, retain the built site and Markdown, provide usable links and report exactly what remains unverified. Do not claim a browser preview was opened when only files were written.

If no method exists in the source, explain that limitation. A deeper explanatory document can organize the claims, but must not present an invented procedure as the author's playbook.
