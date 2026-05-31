# Migration Notes

This importer was created from a personal migration and is provided without warranty.

Lessons learned:

* Test locally before production.
* Create Split Pro users before importing.
* Prefer explicit Splitwise user ID → Split Pro user ID mapping.
* Email matching alone is unreliable.
* Run dry-run first and verify counts.
* Verify balances and expenses after import.
* If using Docker, prefer a temporary helper container on the same Docker network as PostgreSQL.
* The importer was successfully tested against a real migration of approximately 1500 expenses and multiple groups.

## Docker helper container

When Split Pro PostgreSQL runs in Docker, run the importer from a temporary Node helper container on the same Docker network as the database. This is safer than exposing PostgreSQL port `5432` to the host and avoids host DNS failures for service names such as `splitpro-db`.

Recommended workflow:

1. Put the repositories next to each other:

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

5. Start the helper container on that network:

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

6. Inside the helper container:

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

8. Exit:

```bash
exit
```

`--rm` deletes only the helper container after exit. It does not delete the mounted repo and does not touch Split Pro containers.

The helper container mounts both repositories: the importer repo at `/app` and the Split Pro repo read-only at `/split-pro`. `SPLIT_PRO_DIR=/split-pro` makes `pnpm prisma:generate` copy the correct Split Pro Prisma schema from inside the container.

The helper container must join the same Docker network as the database. `DATABASE_URL` must use the database service or container DNS name on that network, for example `splitpro-db`.

Troubleshooting:

* If a host run fails with `Can't reach database server at splitpro-db:5432`, use the temporary Docker helper container.
* If the helper container cannot resolve the database hostname, confirm the network and service name with `docker inspect` and `docker network inspect`.

## Rollback behavior

Rollback uses:

```bash
pnpm import:splitwise --delete-imported --yes
```

It deletes Split Pro expenses whose `transactionId` starts with `splitwise:`. Split Pro's database cascades should remove related participants and notes.

Rollback may not remove groups or users created during import. This is intentional: after an import, those records may have been reused or edited, so deleting them automatically would be riskier than leaving them for manual review.

## Practical checklist

1. Back up the Split Pro database.
2. Generate Prisma Client from the target Split Pro checkout.
3. Confirm `src/currency.ts` matches the target Split Pro checkout's `src/lib/currency.ts`.
4. Create or verify Split Pro users.
5. Create `splitwise-user-map.json`.
6. Run `pnpm import:splitwise --dry-run`.
7. Check unresolved users, skipped expenses, group counts, and expense counts.
8. Run `pnpm import:splitwise --commit`.
9. Verify Split Pro balances and expenses against Splitwise.
10. Keep the database backup until you are satisfied with the migration.
