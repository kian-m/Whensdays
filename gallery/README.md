# Gallery

Each app in this repo is built on the **clSandbox** template (React + Go +
Postgres, containerized, with a visual E2E per feature) and lives on **its own
branch**. This `main` branch stays the clean template plus this catalog.

To run an app, check out its branch and follow its README:

```bash
git checkout app/scheduler
# then: docker compose -f compose.demo.yaml up --build -d   (http://localhost:8080)
```

## Apps

| App | What it is | Branch | Preview |
|---|---|---|---|
| **get-togethers** | A minimal scheduling assistant — host or attend dinners, drinks, movies, trivia and parties; set a time or poll for availability; add friends and see when they're free. | [`app/scheduler`](../../tree/app/scheduler) | [![get-togethers](scheduler/screenshot.png)](scheduler/README.md) |

---

### Adding a new app

1. Branch from `main`: `git checkout main && git checkout -b app/<name>`.
2. Build the app on that branch (extend the template feature by feature; every feature ships a visual E2E test).
3. Capture the home page with `make docs-shots`.
4. Back on `main`, add a `gallery/<name>/` folder (`README.md` + `screenshot.png`) and a row in the table above.
