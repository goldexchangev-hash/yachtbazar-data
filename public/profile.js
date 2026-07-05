/* ============================================================
   profile.js — per-wallet player profiles (window.Profile).

   Storage helpers (localStorage, address-keyed) + a pure stats
   aggregator that turns already-fetched recent-game arrays into a
   single player's stats. No contract access here — app.js fetches
   the on-chain data (it owns `read`/`account`) and passes it in.

   Profile object (key "ctf_profile_<addrLower>"):
     { name, bio, avatarSeed, createdAt, v }
   ============================================================ */
(function () {
  "use strict";

  const GAMES = {
    flip: "Coin Flip",
    dice: "Dice 0-100",
    twodice: "Two Dice",
    crash: "Crash",
    slots: "Slots",
    pressure: "Balloon Pop",
    plane: "Plane",
    slots3d: "Gem Vault",
    fish: "Reef Raiders",
    fishshooter: "Fish Shooter",
    fishshooter2: "Fish Shooter V2",
    swoop: "Sky Swoop",
    blackjack: "Blackjack",
    baccarat: "Baccarat",
  };

  const Profile = {
    GAMES,
    key(addr) { return "ctf_profile_" + String(addr || "").toLowerCase(); },
    load(addr) {
      try { return JSON.parse(localStorage.getItem(this.key(addr))) || {}; }
      catch { return {}; }
    },
    save(addr, patch) {
      try {
        const cur = this.load(addr);
        const next = { v: 1, createdAt: cur.createdAt || Date.now(), ...cur, ...patch };
        localStorage.setItem(this.key(addr), JSON.stringify(next));
        return next;
      } catch { return patch; }
    },
    name(addr) { return (this.load(addr).name || "").slice(0, 24); },

    // ---- per-round RESULTS LEDGER (localStorage ring buffer, address-keyed) ----
    // Fills the gap the on-chain fetch can't see: demo + token rounds and every canvas
    // game. Entry: { g: gameKey, m: "demo"|"token"|"wallet", w: won, b: betUsd, p: netProfitUsd, ts }.
    // Browser-local by design (same trust level as the demo balance itself).
    resKey(addr) { return "ctf_results_" + String(addr || "").toLowerCase(); },
    loadResults(addr) {
      try { return JSON.parse(localStorage.getItem(this.resKey(addr))) || []; }
      catch { return []; }
    },
    recordResult(addr, r) {
      try {
        if (!addr || !r) return;
        const bet = Math.max(0, +r.betUsd || 0), profit = +r.profitUsd || 0;
        if (!(bet > 0) && !r.won) return; // nothing at stake, nothing won → not a round
        const list = this.loadResults(addr);
        const entry = { g: String(r.game || "?"), m: String(r.mode || "demo"), w: !!r.won,
                    b: Math.round(bet * 100) / 100, p: Math.round(profit * 100) / 100,
                    ts: Math.floor(Date.now() / 1000) };
        if (r.push) entry.k = 1; // push / tie (net 0) — counts as neither a win nor a loss
        list.push(entry);
        while (list.length > 600) list.shift(); // ring buffer — newest 600 rounds
        localStorage.setItem(this.resKey(addr), JSON.stringify(list));
      } catch {}
    },
    // Merge a source ledger (the pre-connect "guest" ring) INTO an address's ledger, once, deduped by
    // (ts,g,p,b). Called on wallet connect so play done BEFORE connecting isn't stranded under "guest".
    // Removes the source only after a successful destination write; dedupe makes it idempotent. localStorage only.
    mergeResults(fromAddr, toAddr) {
      try {
        if (!fromAddr || !toAddr || String(fromAddr).toLowerCase() === String(toAddr).toLowerCase()) return;
        const src = this.loadResults(fromAddr); if (!src.length) return;
        const dst = this.loadResults(toAddr);
        const seen = new Set(dst.map((e) => e.ts + "|" + e.g + "|" + e.p + "|" + e.b));
        let added = 0;
        for (const e of src) { const k = e.ts + "|" + e.g + "|" + e.p + "|" + e.b; if (!seen.has(k)) { dst.push(e); seen.add(k); added++; } }
        if (!added) { localStorage.removeItem(this.resKey(fromAddr)); return; }
        dst.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        while (dst.length > 600) dst.shift();
        localStorage.setItem(this.resKey(toAddr), JSON.stringify(dst));
        localStorage.removeItem(this.resKey(fromAddr));
      } catch (e) {}
    },

    // Aggregate a single player's stats from already-fetched recent arrays.
    //   data = { rooms:[], dice:[], twoDice:[], crash:[], slots:[],
    //            local:[], usdToWei: (usd)=>BigInt }   (any may be missing)
    //   `local` = this browser's results ledger (loadResults) — demo/token/canvas rounds
    //   the chain can't see. Chain-covered combos are skipped to avoid double counting.
    //   eq(a,b) = case-insensitive address compare (passed from app.js)
    // All wei values are returned as BigInt; timestamps in unix seconds.
    computeStats(addr, data, eq) {
      const per = { flip: 0, dice: 0, twodice: 0, crash: 0, slots: 0 };
      const perWL = {}; // game → { n, w, l, netWei } (all games, incl. ledger-only ones)
      let wins = 0, losses = 0, wageredWei = 0n, biggestWinWei = 0n, netWei = 0n;
      let memberSinceSec = 0;
      const history = [];
      const FLIP_RAKE_BPS = 300n; // coin-flip 3% rake (matches HOUSE_FEE_BPS)

      const note = (ts) => { if (ts && (!memberSinceSec || ts < memberSinceSec)) memberSinceSec = ts; };
      // netOverrideWei: pass for ledger entries where the loss side can be partial
      // (e.g. a blackjack push) — the default won/lost formula assumes all-or-nothing.
      const record = (game, won, betWei, payoutWei, ts, netOverrideWei, isPush) => {
        per[game] = (per[game] || 0) + 1;
        if (!isPush) { if (won) wins++; else losses++; } // a push/tie is neither a win nor a loss
        wageredWei += betWei;
        const net = isPush ? 0n : (netOverrideWei != null ? netOverrideWei : (won ? (payoutWei - betWei) : -betWei));
        netWei += net;
        if (!isPush && won && net > biggestWinWei) biggestWinWei = net;
        const w = perWL[game] || (perWL[game] = { n: 0, w: 0, l: 0, netWei: 0n });
        w.n++; if (!isPush) { if (won) w.w++; else w.l++; } w.netWei += net;
        note(ts);
        history.push({ game, won, betWei, payoutWei, net, ts, push: !!isPush });
      };

      // Coin Flip (rooms have no .player — derive participation)
      for (const r of (data.rooms || [])) {
        try {
          if (Number(r.status) !== 2) continue; // 2 = Settled
          const isHouse = !!r.isHouseGame;
          const part = eq(addr, r.player1) || (!isHouse && eq(addr, r.player2));
          if (!part) continue;
          const bet = BigInt(r.betAmount);
          const won = eq(addr, r.winner);
          const pot = bet * 2n;
          const payout = pot - (pot * FLIP_RAKE_BPS) / 10000n; // winner takes pot minus 3%
          record("flip", won, bet, payout, Number(r.settledAt || r.createdAt || 0));
        } catch {}
      }
      // Dice 0-100 + Dice #2 (have .player)
      const dgames = [["dice", data.dice], ["twodice", data.twoDice]];
      for (const [key, list] of dgames) {
        for (const d of (list || [])) {
          try {
            if (!eq(d.player, addr)) continue;
            record(key, !!d.won, BigInt(d.betAmount), BigInt(d.payout || 0), Number(d.settledAt || 0));
          } catch {}
        }
      }
      // Crash + Slots (from event logs, if app.js supplied them)
      for (const c of (data.crash || [])) {
        try {
          if (!eq(c.player, addr)) continue;
          record("crash", !!c.won, BigInt(c.betAmount), BigInt(c.payout || 0), Number(c.ts || 0));
        } catch {}
      }
      for (const s of (data.slots || [])) {
        try {
          if (!eq(s.player, addr)) continue;
          const bet = BigInt(s.betAmount), pay = BigInt(s.payout || 0);
          record("slots", pay > bet, bet, pay, Number(s.ts || 0));
        } catch {}
      }
      // Local results ledger (demo/token/canvas rounds). Wallet-mode flip/dice/twodice are
      // already on chain above — skip those combos so nothing double-counts.
      const CHAIN_COVERED = { flip: 1, dice: 1, twodice: 1 };
      const toWei = typeof data.usdToWei === "function" ? data.usdToWei : null;
      if (toWei) {
        for (const e of (data.local || [])) {
          try {
            if (!e || (e.m === "wallet" && CHAIN_COVERED[e.g])) continue;
            const betWei = toWei(Math.max(0, +e.b || 0));
            const netW = toWei(Math.abs(+e.p || 0)) * (+e.p < 0 ? -1n : 1n);
            const payoutWei = betWei + netW > 0n ? betWei + netW : 0n;
            record(e.g, !!e.w, betWei, payoutWei, Number(e.ts || 0), netW, !!e.k);
          } catch {}
        }
      }

      const played = wins + losses;
      // favorite = most-played game
      let favoriteGame = null, favCount = -1;
      for (const k in per) if (per[k] > favCount) { favCount = per[k]; favoriteGame = per[k] > 0 ? k : null; }

      history.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      // current streak: consecutive same-outcome runs from the most recent game (+wins / −losses)
      let curStreak = 0;
      for (const h of history) {
        if (h.push) continue; // a push/tie neither breaks nor extends a streak
        if (curStreak === 0) curStreak = h.won ? 1 : -1;
        else if (h.won && curStreak > 0) curStreak++;
        else if (!h.won && curStreak < 0) curStreak--;
        else break;
      }

      return {
        per, perWL, played, wins, losses,
        winRate: played ? wins / played : 0,
        wageredWei, biggestWinWei, netWei,
        avgBetWei: played ? wageredWei / BigInt(played) : 0n,
        curStreak,
        memberSinceSec,
        favoriteGame, favoriteGameLabel: favoriteGame ? GAMES[favoriteGame] : "—",
        history: history.slice(0, 25),
      };
    },
  };

  window.Profile = Profile;
})();
