# Fovea CLI

Token-budgeted repository navigation for agent shells and CI: a cross-language
code graph with heat-ranked, progressively disclosed context.

## Install

Requires Node.js 20+. No Pi installation, TypeScript loader, or Bend compiler is
needed.

```sh
npm install -g @monotykamary/fovea
# or: bun add -g @monotykamary/fovea
```

The command is `fovea`, regardless of the package's scoped name.

The optional `@ast-grep/cli` dependency provisions the parser for most source
languages. An `ast-grep` on PATH takes precedence over the packaged copy;
`FOVEA_AST_GREP=/path/to/sg` overrides both. Bend-only and config/protocol-only
repositories work without it. If optional dependencies were omitted, install
ast-grep separately before analyzing languages that require it.

## Usage

```sh
fovea sketch /path/to/repo 900
fovea focus /path/to/repo "/v1/messages" 800
fovea impact /path/to/repo --base main 1200
fovea rules /path/to/repo
fovea status /path/to/repo
```

The trailing number is the output token budget. Each CLI invocation is
stateless; use the Pi extension for focus and dwell across an interactive
session.

## Agent skill

The standalone package includes `skills/fovea/SKILL.md`, a portable **fovea**
skill with navigation, impact, coverage, and stateless CLI workflows. Register
that directory with your agent's skill loader, or copy it into the agent's skills
directory. Installing the executable alone does not register the skill.

For a global npm install, the skill directory is
`$(npm root -g)/@monotykamary/fovea/skills/fovea`. It is also available in the
[source repository](https://github.com/monotykamary/pi-fovea/tree/main/skills/fovea).
The separate **pi-fovea** skill covers Pi extension tools and session behavior.

## Pi extension

Install the separate `pi-fovea` package in Pi:

```sh
pi install npm:pi-fovea
```

Both distributions share the same engine and release version. The legacy
`npm install -g pi-fovea` also provides `fovea`; choose only one global package
to avoid competing for the same executable. Installing the extension through
Pi and this CLI globally is supported.

See the [project documentation](https://github.com/monotykamary/pi-fovea#readme)
for language coverage and configuration. Proof sources and generated-kernel
receipts are included for auditing, not required at runtime.
