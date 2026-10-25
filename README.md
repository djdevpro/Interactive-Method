![Interactive Method](assets/banner.png)

# Interactive Method

Turn videos into practical methods and interactive playbooks.

Paste a video link into your AI chat with the plugin enabled.

- Get a summary, method breakdown, screenshots and a Mermaid diagram.
- Ask to go deeper for an editable Markdown playbook and a VuePress site.
- Receive documents in your language. External research runs only on request.

## Install in Codex

Requires Windows x64, Node.js >=22.19.0, npm and pnpm 10.22.0.

```powershell
git clone https://github.com/djdevpro/Interactive-Method.git
cd Interactive-Method
pnpm install --frozen-lockfile --ignore-scripts
pnpm setup:ffmpeg
pnpm package
codex plugin marketplace add ./releases/local-marketplace --json
codex plugin add video-method-lab@learning-coder-local --json
```

Open a new chat after installation. The first VuePress build needs internet access.

[Technical reference](references/cli-contract.md) · [Licenses](NOTICE.md)
