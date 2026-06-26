# get-togethers

**Plans, minus the group-chat chaos.** A minimal scheduling assistant for any
way two or more people get together — dinner, drinks, movie night, trivia,
parties, and everything in between.

**Branch:** `app/scheduler`

![get-togethers home](screenshot.png)

## The idea

- **Host or attend.** Create an event and choose its style: at **your place**
  (with an address) or **"help me find a venue."**
- **Set a time, or poll for one.** Either the host picks the date/time up front,
  or the event opens in a **polling stage** — share the link and invitees mark
  which proposed times work. The host then locks one in.
- **Preferences, one question at a time.** After RSVPing, guests answer a couple
  of quick questions tuned to the event type (dietary + cuisine for dinner,
  genre for a movie, a team name for trivia…), Airtable-style.
- **Minimal profile.** Just a name and a handle, plus an optional weekly
  availability grid.
- **Friends.** Add people by handle (request + accept); once connected you can
  see when they're generally free — and accepting events updates that picture.

## Run it

```bash
git checkout app/scheduler
docker compose -f compose.demo.yaml up --build -d   # http://localhost:8080, no Clerk needed
```

See the branch's `README.md` for the full feature guide and API.
