# Token crash rounds — server-paced live rounds (manual-default cash-out)

> **One-line summary:** the crash family (crash / plane / swoop / pressure) now has a
> server-paced round-runner so **manual tap-to-cash-out** works provably-fairly in token
> mode. Manual is the **DEFAULT**; auto-cash-out is opt-in (owner rule:
> *"load with auto cash-out OFF until they turn it on"*). Everything below is **dormant**
> until the token bridge is enabled (`ENABLE_TOKEN_BRIDGE=1`) — the live demo is untouched.

---

## Why a server-paced round (and not just the client)

In token mode the crash point is **committed but secret** during the round. If the client
knew it, it could cheat; if nobody paced the climb, the client couldn't honestly animate a
live multiplier to tap against. So the **server** runs the round: it holds the secret crash
point (derived from the committed session seed), paces the rising curve, fires the bust at
the exact millisecond, and validates every cash-out against the **server clock**. This is
the Bustabit/Stake model. The client only ever gets `startedAt + k` to animate — never the
crash point until it busts. **No VRF** — pure commit-reveal.

---

## File map (what to edit, and where)

| File | Role | Edit it to… |
|------|------|-------------|
| `server/crash-rounds.js` | The round-runner core. `startRound / cashOut / _resolve`, secret crash point, bust timer. | change pacing, the manual/auto rules, add an `onResolve` consumer. **Self-test:** `node server/crash-rounds.js` |
| `server/crash-rounds-ws.js` | The `cr:*` ws sub-protocol. Auth + start/cashout + pushes the reveal. `CRASH_GAMES` whitelist. | add a channel to `CRASH_GAMES`; change wire messages. **Self-test:** `node server/crash-rounds-ws.js` |
| `server/games/crash.js` | The pure crash engine. `crashPointOf()` lets the runner pre-derive the point. | change house edge / cap (mirror the contract!). **Self-test:** `node server/games/crash.js` |
| `server/token-bridge.js` | The token ledger. `crashPointPeek()` = next-bet crash point without burning the nonce. | — (shared ledger; touch with care) |
| `server/token-http.js` | HTTP token service. `verifySession()` = the auth gate the ws reuses. | — |
| `server/server.js` | Wires `cr:*` onto the existing ws (mirrors `bj:*`). | — (already wired) |
| `public/crash-rounds-client.js` | **CLIENT seam.** `make({send}).start({...}) / cashOut() / handle(msg)`. Animates from `startedAt + k`. | the only client file a channel imports. **Self-test:** `node public/crash-rounds-client.js` |
| `public/app.js` | Pipes every `cr:*` ws frame into `CrashRounds.handle()`; creates the `CrashRounds` singleton. | — (already wired) |

---

## The `cr:*` wire format

```
Client → server:
  { type:"cr:start",   sessionId, sessionToken, gameKey, betUnits, autoTarget?, clientSeed? }
                                       autoTarget absent/0  ⇒  MANUAL (the DEFAULT)
  { type:"cr:cashout", roundId }       manual tap — server settles at ITS multiplier
  { type:"cr:ping" }
Server → client:
  { type:"cr:started", roundId, startedAt, k, gameKey, bet, autoTarget, serverNow }
  { type:"cr:result",  roundId, busted, win, cashOutAt, crashPoint, payoutUnits, tokens, ... }
  { type:"cr:error",   code, message, roundId? }     codes: auth | start | owner | cashout | server
  { type:"cr:pong" }
```

---

## Wiring a channel onto it (the recipe)

Each crash-family channel keeps **its own visuals** and just drives them from `onTick`.
Replace the channel's old local crash engine with these ~10 lines (token mode only — keep
the demo path for play-money):

```js
// when the player presses PLAY in token mode:
const sess = TokenMode.session();            // { sessionId, sessionToken } from the open buy-in
CrashRounds.start({
  sessionId:  sess.sessionId,
  sessionToken: sess.sessionToken,
  game: "swoop",                             // must be in CRASH_GAMES (server/crash-rounds-ws.js)
  betUnits: stakeUsd,
  autoTarget: autoOn ? autoX : 0,            // 0 = MANUAL (DEFAULT). Toggle starts OFF.
  onTick: function (mult, elapsedMs, result) {
    if (result) return;                      // result frame: the .then below handles it
    HUD.setMultiplier(mult);                 // ← your channel's live readout
    Renderer.climbTo(mult);                  // ← your channel's animation
  },
})
.then(function (res) {
  if (res.busted) Renderer.boom(res.crashPoint);          // exploded at crashPoint
  else            Renderer.cashOut(res.cashOutAt, res.payoutUnits); // won
  HUD.setTokens(res.tokens);
})
.catch(function (e) { toast(e.message); });  // auth / owner / server errors

// the CASH OUT button:
cashOutBtn.onclick = function () { CrashRounds.cashOut(); };
```

**Manual/auto toggle (owner rule):** the auto-cash-out switch must render **OFF** on load.
Only when the player flips it on do you pass a non-zero `autoTarget`. With auto OFF the round
climbs until they tap **Cash Out** (or it busts).

---

## Known constraints / gotchas (read before editing)

1. **Nonce reservation.** `crashPointPeek()` derives the next bet's crash point *without*
   burning the nonce, and the settling `play()` uses that same nonce. The round-runner
   enforces **one live round per session**, so they always match — *but* a concurrent HTTP
   `/api/token/play` on the same session during a live round would burn the nonce and
   desync. Don't let a player run a discrete HTTP game and a live crash round on the same
   session at the same time. (A future hardening: have `peek` actually reserve the nonce.)
2. **Latency is player-safe.** The client clock starts on `cr:started` receipt, so it can
   only **lag** the server, never lead. A manual tap settles at the (slightly higher) server
   multiplier; you can't claim a stale-low value or out-run the bust. The bust may arrive a
   few hundred ms "late" visually — the client snaps to `crashPoint` on `cr:result`.
3. **Disconnect = still settles.** If the socket drops mid-round, the server timer still
   fires and settles the bet into the ledger; the player just doesn't see the reveal.
4. **`plane`/`swoop`/`pressure` settle through the `crash` engine** (aliased in the bridge),
   so the math/house-edge is identical across all four. The visuals differ; the money doesn't.

---

## To make ANY of this live (owner, ~5 min — I can't do on-chain steps)

1. `node server/genkey.js` (or your existing house key) → a signer private key.
2. On Render, set: `ENABLE_TOKEN_BRIDGE=1`, `HOUSE_SIGNER_KEY=0x…`, `SEPOLIA_RPC_URL=…`.
3. On-chain: `setBlackjackSigner(<house signer address>)`.
4. Fund the house: `fundHouse()` so cash-outs can pay.

Until then `verifySession` returns null, every `cr:start` is rejected, and the demo runs
exactly as before. After enabling, the whole token path (HTTP discrete games **and** these
live crash rounds) can be tested end-to-end against the testnet.
