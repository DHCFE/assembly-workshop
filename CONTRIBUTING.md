# Contributing

Run `npm ci`, `npm run build`, `npm test` and `python3 -m unittest discover -s tests -p 'test_*.py'` before proposing changes. When changing interaction code, run the Chromium test suite and try a pointer-driven placement in the browser. When changing scene compilation or generation, run the Blender-enabled integration test in `docs/architecture.md`.

Keep mesh names and source step order stable for a published scene. Record the asset source and redistribution terms with a new example. For a report about performance or controls, include the scene name, operating system, browser, and the action you were doing.
