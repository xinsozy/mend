# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xinsozy/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xinsozy/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in four
formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone. See `SPEC.md` in the
[starter kit](https://make.fun/c/hidden-spec-cli-01-run-20261122/kit) for the
full specification. Practice set: 100/100 checks passed (score 1000).

Entry for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
