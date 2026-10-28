# SharedLayers for Claude Code

With this plugin, the comments you leave on your local app with the SharedLayers
Chrome extension, in an AI layer, go straight to Claude Code open in that
project. Claude makes the change and answers in the comment's thread.

Install it once, in Claude Code, in the terminal or the desktop app:

    /plugin marketplace add SharedLayers/claude-plugin
    /plugin install sharedlayers@sharedlayers

More at [sharedlayers.com/docs/ai-layers](https://sharedlayers.com/docs/ai-layers).

## What it does

- **A listener with every session** (`hooks/hooks.json`): at session start a
  background hook runs `scripts/ai.mjs wake`, which starts `ai.mjs serve` in
  the project for as long as the session lasts, then waits. It stays silent
  until there is a request, then wakes Claude with one line per request or
  reply (an `asyncRewake` hook, so it works while Claude is idle, in the
  terminal and in the desktop app). After each of Claude's turns, a Stop hook
  starts the next wait.
- **The extension reaches the project through it**, on 127.0.0.1 at a port from
  47820 to 47839, so the browser never asks for the project folder. Only the
  SharedLayers extension is let in.
- **A line of context at session start** (`hooks/hooks.json`), only in projects
  that have an AI layer.

Comments, pictures and the helper are kept in the project's `.sharedlayers`
folder, which keeps itself out of git. Nothing is sent anywhere else.

`scripts/ai.mjs` is the same helper sharedlayers.com serves at `/ai.mjs`. This
repository is published from SharedLayers with each release of the plugin.
