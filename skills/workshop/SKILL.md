---
name: assembly-workshop
description: Turn an existing Blender model or a reference image into a playable assembly scene, using the Assembly Workshop scene format and local browser runtime.
---

# Assembly Workshop

Read the project README and `docs/scene-format.md`. Work from a user-authorized reference or `.blend` file. Choose components by actual geometry and construction order. Give every mesh a stable name and its own source step. Use the supported operations and interactions, plus whole-unit installation for components assembled alongside the model.

Prepare a scene directory containing a Blender source file and `recipe.json`. From the repository root run `python3 runtime/cli.py import <scene-directory>`. Keep generated project data in the same data directory as the running workbench. Open the reported `/play/…/` route on the local service. Use a dedicated test profile to verify placement, intermediate geometry, reload and export. To generate from a photo, use the built-in upload entry with a configured vision provider.

The browser is the shared play surface. If the host supports a preview panel, open the play URL there. For the best hands-on experience, open the same URL in a full-screen desktop browser and use a mouse.
