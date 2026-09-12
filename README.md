# dsh-skill-memory

A DSH / Cordis plugin that gives an agent a durable memory of the workspace it
works in.

- **Recall:** before each model step it matches the current turn's query against
  stored skills and injects the matching instructions into the step. Skills
  marked `pinned` are injected on every step regardless of match.
- **Learn:** after each completed turn a background model call extracts durable
  knowledge from the turn - concrete entry points, gotchas, workflows, and
  personal preferences - and creates or merges skills. A bounded queue drops
  work instead of blocking replies.
- **Manage:** it registers a `skill_memory` tool with `list`, `search`, `recall`,
  `check`, `probe`, `add`, `forget`, `pin`, `stats` and `diag`.

Plain JavaScript, no dependencies. It uses only DSH services (`tools`, `fs`,
`llm`, `sessions`). No Python, no vector database, nothing to compile.

## Install

The package declares `dsh.bundle.patch`, so installing it makes it a profile
layer: the patch inserts one host-plane row, the plugin mounts once per process,
and every session in that profile gets the tool and the hooks. No agent preset
has to carry a row.

```sh
# from a local checkout
dsh plugin --profile web add ./path/to/dsh-skill-memory/package

# from git
dsh plugin --profile web add github:Oyun-Teknolojileri/dsh-skill-memory

# from npm, once published
dsh plugin --profile web add dsh-skill-memory
```

`dsh plugin` forwards its arguments to pnpm inside the profile directory and then
reconciles `dsh.profile.bundles` against what is installed, so a dependency that
declares `dsh.bundle` joins the layer stack by itself.

Restart the profile afterwards, or rely on the profile's patch reload.

### Verify

```sh
dsh --profile web --dump-config | grep -A2 skill-memory
```

The composed tree should show the inserted row. In a session, ask the agent to
run `skill_memory diag`: it reports hook counters (steps seen, blocks injected,
turns analyzed) and the resolved store paths.

## Configure

Optional, but this is how repo aliases and the personal/global store are set.
Create `<workspace>/.dsh-skill-memory.config.json`:

```json
{
  "aliases": {
    "engine": "/absolute/path/to/another/repo",
    "plugin": "Plugins/plugin-dir"
  },
  "globalStore": "/absolute/path/to/skill-memory.json",
  "home": "/absolute/path/to/home"
}
```

| Key | Meaning |
| --- | --- |
| `aliases` | A skill entry point may name a repo alias instead of `self`. An alias is absolute, or relative to the workspace root. |
| `globalStore` | Where personal/global skills live, shared by every workspace pointing at the same path. Absent means the global layer is disabled. |
| `home` | Optional. Used only to expand a leading `~` in `globalStore`, because the fs layer treats a tilde as a literal directory name. |

## Stores

| Store | Contents |
| --- | --- |
| `<workspace>/.dsh-skill-memory.json` | Project knowledge. Wins on id collision. |
| `globalStore` from the config | Personal preferences shared across workspaces. |

On write, all skills go to the workspace store, and global-scope skills are
additionally written to the global store. If the global store is unavailable,
global skills still persist in the workspace store, so nothing is lost. Records
never embed an absolute workspace path, so a store file is safe to share.

## Skill record

```
id, scope (workspace|global), kind (api|workflow|gotcha|preference|note),
name, description, instructions, triggers[], refs[], tags[], pinned,
source, confidence, version, uses, created_at, updated_at, evidence[]
```

A `refs` entry is `{ repo, path, symbol, seenVersion, seenSize, verified }`. At
capture time each ref is stat-ed for its FsVersion and its `symbol` is verified
against the file text, so a wrong or invented name is reported as
`(NOT FOUND in that file)` instead of being trusted. If a ref's path resolves
nowhere under its repo, capture tries every other repo root and re-points the
alias when exactly one matches.

## Uninstall

```sh
dsh plugin --profile web remove dsh-skill-memory
```

The knowledge files are left in place.

## Notes

- The row is host-plane: the plugin sees every session in the profile. Session
  buffers and query caches are keyed by session id, and the store cache by
  workspace, so concurrent sessions do not mix state.
- Retrieval is lexical (diacritic-folded token overlap plus trigger phrases),
  not vector search. Scoring lives in `matchSkill()` so a vector backend can
  replace it.
- Skills are learned and matched in the conversation language; there is no
  translation step, so a query only matches triggers written in that language.
- Validation covers refs, symbols and file freshness - not instruction prose.
  Nothing is ever auto-deleted.
- Publishing checklist: add a `license` field and a `repository` URL to
  `package.json`, then `npm publish`.
