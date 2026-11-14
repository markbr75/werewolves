# Werewolf, with live video

A browser game of Werewolf for 4 to 18 players. Everyone joins from their own
phone or laptop. Play online with cameras on, or in person around a table. A
built-in narrator runs the game, so the host gets a role and plays too.

## Online or in person

The host picks the mode when starting a village and can change it in the lobby.

| | Online | In person |
| --- | --- | --- |
| Video | Cameras on. At night only the werewolves see and hear each other. | None. No camera or microphone is asked for. |
| Narrator | Speaks on every player's device. | Speaks only on the host's phone, for the whole room. Turn it up or pair a speaker. |
| Role card | Shown on your screen. | Face down: press and hold to peek. |
| Night | Sleepers see a black screen. | Every phone shows the same dark screen, the pack is never marked, and players with no night job tap a name too, so nobody stands out. |

The narrator announces each phase, plays a wolf howl and night sounds, and calls
out the time left (one minute, thirty seconds, ten seconds). It uses the
browser's built-in speech, so the voice differs between devices. The Voice
button turns it off on a device. Screens are kept awake during a game where the
browser allows it.

## Roles

| Role | What it does |
| --- | --- |
| Werewolf | Each night the pack agrees on one villager to kill. |
| Seer | Each night learns whether one player is a werewolf. |
| Doctor | Each night protects one player. Not the same player twice running. (5+ players) |
| Hunter | Fires one last shot when killed or banished. (6+ players) |
| Witch | One healing potion and one poison, each usable once. (7+ players) |
| Villager | No power. Talks, watches, votes. |

Werewolves by default: 1 for 4 to 6 players, 2 for 7 to 10, 3 for 11 to 14,
4 for 15 to 18. The host can change the number and switch roles off in the lobby.

## How a round runs

1. **Lobby.** One person starts a village and shares the 4-letter code or invite link.
2. **Roles.** Each player privately sees their role. Wolves see their pack.
3. **Night.** Screens go black. Wolves see and hear only each other and pick a
   victim. The seer and doctor act from their dark screens, then the witch.
4. **Dawn.** The village learns who died.
5. **Day.** Cameras back on. Talk, then vote to banish someone. A tie banishes nobody.
6. Repeat until the wolves are all gone (village wins) or the wolves equal the
   villagers in number (wolves win).

Dead players keep their camera and can watch by day, but their microphone is off.

## Setup

You need Node.js 20.12 or newer and a free LiveKit Cloud project for the video.

1. Sign up at https://cloud.livekit.io and create a project.
2. In the project, go to Settings > Keys and create an API key.
3. Copy `.env.example` to `.env` and fill in the project URL, key and secret.
4. Run:

   ```
   npm install
   npm start
   ```

5. Open http://localhost:3000. Open it in a few browser tabs to try it alone.

Without the three LiveKit values the game still runs, with initials instead of video.

## Putting it online

Browsers only allow camera access over HTTPS, so friends need an HTTPS address.
The app is one Node process that keeps games in memory, so run a single instance.

**Azure App Service**

```
az webapp up --name <your-app-name> --runtime "NODE:22-lts" --sku B1
az webapp config set --name <your-app-name> --resource-group <group> --web-sockets-enabled true
az webapp config appsettings set --name <your-app-name> --resource-group <group> \
  --settings LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...
```

WebSockets must be on. Keep the instance count at 1.

**Anything that runs a container** (Azure Container Apps, Render, Fly.io, Railway):
build the included `Dockerfile`, set the three `LIVEKIT_*` variables, expose port 3000.

**Quick test with friends from your own machine:** run `npm start`, then
`npx localtunnel --port 3000` or `ngrok http 3000` and share the HTTPS address.

## Keeping it private

Set `HOST_PASSCODE` to a secret word. Then only someone who knows the word can
start a village; players joining with a village code do not need it. Without it,
anyone who finds the address can start their own game on your video allowance.

Other protections: a village stops accepting players once the game starts, and a
visitor who enters 8 wrong codes or passcodes is locked out for ten minutes.
Nothing is recorded or stored, and a game is forgotten when it ends.

## How the night blackout is enforced

Each player's browser tells the LiveKit server who may receive their camera and
microphone (`setTrackSubscriptionPermissions`):

- By day: everyone.
- At night, a living werewolf: only the other living werewolves.
- At night, everyone else: nobody.

LiveKit applies this on the server, so a sleeping player's device is never sent
the wolves' video or audio. It is not just hidden on screen. The game server
also only ever sends each player the information their role is allowed to know.

## Testing

`npm test` starts a server with fast timers, plays 17 complete games with bot
players (4 to 18 players) and checks every message for leaked secrets.

The live video path needs a real LiveKit project and real cameras, so try a
night with three or four people before a big game.

## Files

- `server.js`: web server, WebSocket connections, LiveKit tokens.
- `game.js`: the rules. All timings are at the top in `TIMES`.
- `public/`: the player screen (`index.html`, `style.css`, `app.js`).
- `test/simulate.js`: bot players.
