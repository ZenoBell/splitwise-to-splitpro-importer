# Splitwise → Split Pro Importer

Unofficial one-time migration utility for importing Splitwise history into Split Pro.

> This project is unofficial and is not affiliated with Splitwise or Split Pro.
>
> This project uses the official Splitwise API and requires users to provide their own API credentials.
>
> Users are responsible for ensuring their use complies with the terms of the services involved.
>
> Always back up your database before running the importer.

This tool was created from a personal migration and is provided without warranty.

## Features

* Dry run mode
* Commit mode
* Rollback mode
* Explicit user mapping
* Idempotent imports
* Group import
* Expense import
* Expense notes preserving original Splitwise metadata

## Important limitations

* Multi-payer expenses are skipped
* Unsupported currencies are skipped
* Deleted Splitwise expenses are skipped
* Unresolved users must be mapped or created
* This is a migration tool, not an ongoing synchronization tool

## Before You Run This

* Back up PostgreSQL.
* Create or log into all required Split Pro users.
* Generate Prisma Client from the target Split Pro schema.
* Create `splitwise-user-map.json`.
* Run `pnpm import:splitwise --dry-run` successfully.
* Verify user mappings.
* Verify planned import counts.
* Only then run `pnpm import:splitwise --commit`.

## Required Split Pro version

This importer keeps Prisma and the existing Split Pro data model. It expects a Split Pro checkout whose Prisma schema contains:

* `User.id` as an integer primary key
* `Group.splitwiseGroupId`
* `Expense.transactionId`
* `ExpenseParticipant`
* `ExpenseNote`
* `SplitType.EXACT`
* `SplitType.SETTLEMENT`

Tested with:

* Split Pro commit `1693b5e`
* Prisma `6.19.3`
* Node `22.x`

It was extracted from a Split Pro checkout using the post-UUID expense schema. Before publishing or running against another Split Pro version, compare the importer writes in `src/import-splitwise.ts` with that checkout's `prisma/schema.prisma`.

The importer validates currencies using the same definitions as Split Pro. The bundled `src/currency.ts` table was copied from Split Pro commit `1693b5e` so currency validation and decimal precision match that Split Pro version exactly. If your Split Pro version differs, replace `src/currency.ts` with the version from your checkout.

## Install

Clone this repository next to a checked-out Split Pro repository:

```bash
git clone <split-pro-repo-url> split-pro
git clone <this-repo-url> splitwise-to-splitpro-importer
cd splitwise-to-splitpro-importer
pnpm install
pnpm prisma:generate
```

By default, `pnpm prisma:generate` copies `../split-pro/prisma/schema.prisma` into this repo as `prisma/schema.prisma`, then generates Prisma Client into this repo's `node_modules`. This makes `import { PrismaClient, SplitType } from '@prisma/client'` work from the importer.

If your Split Pro checkout is elsewhere:

```bash
SPLIT_PRO_DIR=/path/to/split-pro pnpm prisma:generate
```

The generated Prisma Client comes from your local Split Pro schema. Do not commit generated clients, copied schemas, `.env` files, API tokens, database URLs, or real mapping files.

Before running the importer, confirm the bundled `src/currency.ts` matches the target Split Pro checkout's `src/lib/currency.ts`. Replace it with the target version's file if they differ.

## Required environment variables

```bash
DATABASE_URL
SPLITWISE_ACCESS_TOKEN
```

`DATABASE_URL` must point to your Split Pro PostgreSQL database. `SPLITWISE_ACCESS_TOKEN` must be your own Splitwise API bearer token.

`SPLITWISE_API_KEY` is also accepted as a fallback name for the same bearer credential:

```bash
SPLITWISE_API_KEY
```

## Getting a Splitwise Token

Create a Splitwise API application or personal access credential from the official Splitwise developer settings, then use the bearer token as `SPLITWISE_ACCESS_TOKEN`.

Splitwise currently documents API access at:

```text
https://secure.splitwise.com/apps
```

Use credentials for your own Splitwise account. Do not commit the token to git, paste it into docs, or put it in `splitwise-user-map.json`.

## User mapping

Create a local `splitwise-user-map.json` in this repository root. Start from the example:

```bash
cp examples/splitwise-user-map.example.json splitwise-user-map.json
```

Example:

```json
{
  "31971127": {
    "splitProUserId": "1",
    "note": "Example User"
  }
}
```

Use `--list-splitpro-users` to see Split Pro users:

```bash
pnpm import:splitwise --list-splitpro-users
```

Prefer explicit Splitwise user ID to Split Pro user ID mappings. Email matching exists as a fallback, but it is not reliable enough for a migration you cannot easily eyeball.

## Finding Split Pro User IDs

Before importing, create or log into all required Split Pro users.

To list existing users and their IDs from a running Split Pro database:

### Docker deployment

Run a temporary shell in the importer container environment:

```bash
docker run --rm -it \
  --network <splitpro-network> \
  -v "$PWD":/app \
  -v "/path/to/split-pro":/split-pro:ro \
  --env-file "/path/to/splitpro.env" \
  -e SPLIT_PRO_DIR="/split-pro" \
  -w /app \
  node:22.16.0-alpine3.21 \
  sh
```

Inside the container:

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm install
pnpm prisma:generate
```

List users:

```bash
node -e '
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

(async () => {
  const users = await db.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
    },
    orderBy: { id: "asc" },
  });

  console.table(users);
  await db.$disconnect();
})();
'
```

Example output:

```text
┌─────────┬────┬───────────┬───────────────────────┐
│ (index) │ id │ name      │ email                 │
├─────────┼────┼───────────┼───────────────────────┤
│ 0       │ 1  │ Example A │ user-a@example.invalid │
│ 1       │ 4  │ Example B │ user-b@example.invalid │
└─────────┴────┴───────────┴───────────────────────┘
```

Use those IDs in `splitwise-user-map.json`.

Example:

```json
{
  "31971127": {
    "splitProUserId": "1"
  },
  "31971238": {
    "splitProUserId": "4"
  }
}
```

## Usage

```bash
pnpm import:splitwise --dry-run
pnpm import:splitwise --commit
pnpm import:splitwise --delete-imported --yes
```

Dry run fetches Splitwise data, validates mappings, prints found Splitwise users, prints the import plan, and does not write to the database.

Example dry-run summary:

```text
Splitwise users found:
- splitwiseId=31971127 | name="Example User" | email=(none) | groups=Example Group | totals=EUR paid=120 owed=95 | resolution=mapped to User.id 1

Import plan
- Users to create: 0
- Unresolved users: 0
- New groups: 12
- New expenses: 812
- Already imported expenses: 0
- Skipped expenses/items: 22

Expenses by group:
- Example Group: 134
- non-group: 18
```

Commit mode writes directly to the configured Split Pro database. Back up the database first, run dry-run first, and verify the planned counts before committing.

Rollback mode deletes imported expenses whose `transactionId` starts with `splitwise:`. Cascading deletes should remove those expenses' participants and notes. Rollback may not remove created groups or users.

Splitwise payments are imported as Split Pro settlement expenses with `SplitType.SETTLEMENT`. Regular Splitwise expenses are imported with `SplitType.EXACT`. Multi-payer items are skipped because the importer currently requires one identifiable payer.

Large Splitwise accounts may hit Splitwise API rate limits. The importer fetches expenses in pages, but it does not implement a retry/backoff queue. If Splitwise returns a rate-limit or temporary API error, wait and rerun dry-run or commit. Already imported expenses are skipped by `transactionId`, so reruns are idempotent for expenses.

## Docker

If Split Pro PostgreSQL runs in Docker, the safest default is to run the importer from a temporary helper container on the same Docker network as the database.

Running from the host often fails when `DATABASE_URL` uses a Docker service hostname such as `splitpro-db`, because that hostname is only resolvable inside the Docker network. The helper container avoids exposing PostgreSQL port `5432` to the host.

Back up the Split Pro database before running the importer.

1. Put `split-pro` and `splitwise-to-splitpro-importer` next to each other:

```text
parent/
├── split-pro/
└── splitwise-to-splitpro-importer/
```

2. Generate Prisma locally first:

```bash
cd splitwise-to-splitpro-importer
pnpm install
pnpm prisma:generate
```

3. Create `splitwise-user-map.json` in the importer repo root.

4. Find the Docker network used by the Split Pro database:

```bash
docker inspect <splitpro-db-container-name> --format '{{json .NetworkSettings.Networks}}'
```

5. Run a temporary Node container on that same network:

```bash
docker run --rm -it \
  --network <db-network-name> \
  -v "$PWD":/app \
  -v "$(cd ../split-pro && pwd)":/split-pro:ro \
  -w /app \
  --env-file /path/to/splitpro.env \
  -e SPLIT_PRO_DIR="/split-pro" \
  -e DATABASE_URL="postgresql://USER:PASSWORD@splitpro-db:5432/DATABASE" \
  -e SPLITWISE_ACCESS_TOKEN="$SPLITWISE_ACCESS_TOKEN" \
  node:22.16.0-alpine3.21 \
  sh
```

6. Inside the temporary container:

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm install
pnpm prisma:generate
pnpm import:splitwise --dry-run
```

7. If dry-run looks correct:

```bash
pnpm import:splitwise --commit
```

8. Exit the helper container:

```bash
exit
```

`--rm` deletes the helper container after exit. It does not delete the mounted repo. It does not touch Split Pro containers.

The helper container mounts both repositories: the importer repo at `/app` and the Split Pro repo read-only at `/split-pro`. `SPLIT_PRO_DIR=/split-pro` makes `pnpm prisma:generate` copy the correct Split Pro Prisma schema from inside the container.

The helper container must join the same Docker network as the database. The `DATABASE_URL` hostname must match the database service or container DNS name on that network, for example `splitpro-db`.

Troubleshooting:

* If a host run fails with `Can't reach database server at splitpro-db:5432`, use the temporary Docker helper container.
* If the helper container cannot resolve the database hostname, confirm the network and service name with `docker inspect` and `docker network inspect`.

## Safety

The importer is idempotent for expenses by using `transactionId = splitwise:<splitwiseExpenseId>`.

The mapping file is validated before planning. Invalid Splitwise IDs, invalid Split Pro user IDs, missing mapped users, and malformed entries fail early.

Commit mode prints a warning before writing. There is no interactive prompt, so automation can still run the script.

Rollback is intentionally narrow: it deletes imported expenses only. It may leave created groups and users in place so it does not accidentally delete data that may have been reused after import.
