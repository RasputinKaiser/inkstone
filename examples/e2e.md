# Fixture end-to-end example

From the repository root:

```sh
npm install
npm run verify:fixture
```

The verifier creates synthetic sources in a temporary directory, builds the
canonical fixture project, applies a caption command in memory, renders the
project with fixed FFmpeg arguments, and verifies the receipt against the
unchanged project revision. It prints a JSON summary and removes temporary
media on exit.

To inspect the same document manually:

```sh
node dist/src/cli.js inspect --project examples/fixture-project.json
node dist/src/cli.js validate --project examples/fixture-project.json
```
