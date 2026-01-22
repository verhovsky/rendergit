# rendergit

See all the code of a repository as a single scrollable, syntax highlighted page.

Vibe-coded with [Codex](https://www.npmjs.com/package/@openai/codex).

Sorts files/directories from oldest to newest so it takes a long time to run (default). Use `--sort=filename` to skip git history lookup and render faster.

## Basic usage

```bash
npm install
node rendergit.mjs https://github.com/verhovsky/rendergit
```

You can also pass a local directory.
