# Development

This repository (nanocodexyz/egress, MIT or Apache-2.0) is `nanocode-egress`, an extension of nanocodexyz/nanocode-ts that runs nanocode agents on a user's own ChatGPT or Claude plan on Cloudflare Workers and Vercel: it signs the user in, keeps the plan's OAuth credential sealed and owned in one place, and injects it into the session's model requests at the egress, so the agent's runtime never holds it. It follows nanocode-ts's TypeScript conventions (namespace modules, `.ts` imports, factories rather than classes except Durable Objects, option bags, TSDoc on exports). Check with `npm run check:types` and `npm test` (`node --test` over `test/*.test.ts`, with mocked OAuth and provider endpoints), and `npm run build` writes `dist/`, which `prepare` builds when the package is installed from Git.

## Principles

These principles come from nanocodexyz/nanocode's `AGENTS.md` and apply to every change here.

- Keep code simple and changes small. Match the surrounding code and preserve unrelated work.
- No new code comments, doc comments, README edits, tests or test-only dependencies.
- No magic constants or arbitrary caps: a limit comes from a protocol, a measurement or caller policy. Surface invalid states; never hide them with silent truncation, clamping or fallbacks.
- Make invalid states unrepresentable: model a lifecycle as one discriminated union whose variants carry only what that phase has.
- Preserve public APIs.
- Inference, subagents and durability live in the brain; Code Mode runs on the user's machine. Never silently replay dispatched work: report uncertain outcomes.
- Validate with `npm run check:types` and the existing `npm test`, and back performance changes with reproducible before/after measurements.
- Check behavior with harnesses in ignored `output/`. Keep every artifact there; never commit them, credentials or personal data.
- Work on master in the main checkout, commit only your own changes and push each one; no pull requests. There is no CI: build, release and deploy by hand. Use subagents only when asked.
- This file holds principles only and rarely changes. DECISIONS.md is the growing log: add what each change establishes and why, with the commands, dates and measurements behind it.
