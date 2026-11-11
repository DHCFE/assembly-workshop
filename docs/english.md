# Assembly Workshop

[Play in your browser](https://dhcfe.github.io/assembly-workshop/) · [中文文档](../README.md)

Pick a part from the tray, move it into the scene, and shape it in place. Assembly Workshop turns a Blender scene and a construction recipe into a playable build. The browser handles movement, shaping, difficulty, motion and recording. Saved work can be resumed or exported to Blender through a local service.

For the most precise controls, use a desktop browser in full screen and a mouse. Start with the wooden watermill on Easy or Medium. Drag a part into its outline, then follow the handle. Drag empty space to orbit and scroll to zoom. Play is available on browsers with WebGL 2. The scene link accepts `?quality=low` for a lighter display.

## Run locally

Use Node.js 20+ and Python 3.10+. Install Blender 5.2 LTS for scene creation and `.blend` export.

```sh
npm ci
npm run build
python3 runtime/server.py
```

Open `http://127.0.0.1:8765/`. The static site in `dist/` supports the bundled scenes, browser saves, checkpoint import and download, and recording. The server additionally supports photo generation and Blender exports. Photo generation requires a configured vision provider. Use `--provider codex` with a logged-in Codex CLI, `--provider claude-code` with Claude Code, or configure an image-capable Chat Completions API using `.env.example` and Docker Compose. The automatic photo pipeline produces lightweight editable geometry. Import a detailed Blender scene for handcrafted geometry.

See the [main README](../README.md#self-host) for setup, [scene format](scene-format.md) for authoring and [asset licenses](assets.md) for redistribution. Code and original example assets are GPL-3.0-or-later. Third-party notices are in `licenses/`.
