# Contributing

Thanks for helping. This SDK wraps a HTTP API that it does not control, so the
most valuable contributions are usually about *behaviour we got wrong* rather
than features we are missing.

## Getting set up

```bash
npm install
npm test          # unit tests, no install required
npm run typecheck
npm run build
```

## Running against a real install

The unit tests use a stubbed transport, which cannot catch drift between this
SDK and the Python services it talks to. The live suite can:

```bash
cp .env.example .env      # fill in EXPERTS_BASE_URL and EXPERTS_TEST_KEY
npm run test:live
```

It creates only hidden conversations and deletes them afterwards. Point it at
a development install, never production.

## What we look for in a change

- **A test that fails without it.** For a bug, that test should describe the
  behaviour, not the fix.
- **Comments that explain why, not what.** Most of the surprising code here is
  surprising because the API is, and the comment should say which part.
- **No new runtime dependencies.** This package ships zero on purpose, so it
  can go anywhere without an audit.

## Reporting an API problem

If the API itself misbehaves — a shape that does not match its documentation, a
silent failure — open an issue with the raw request and response. Those are
often fixed on the server rather than papered over here, and knowing which is
the point of the report.

## Security

Do not open an issue for a vulnerability. See [SECURITY.md](SECURITY.md).
