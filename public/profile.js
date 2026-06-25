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
    dice: "0-100",
    twodice: "Dice #2",
    crash: "Crash",
    slots: "Slots",
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

    // Aggregate a single player's stats from already-fetched recent arrays.
    //   data = { rooms:[], dice:[], twoDice:[], crash:[], slots:[] }  (any may be missing)
    //   eq(a,b) = case-insensitive address compare (passed from app.js)
    // All wei values are returned as BigInt; timestamps in unix seconds.
    computeStats(addr, data, eq) {
      const per = { flip: 0, dice: 0, twodice: 0, crash: 0, slots: 0 };
      let wins = 0, losses = 0, wageredWei = 0n, biggestWinWei = 0n, netWei = 0n;
      let memberSinceSec = 0;
      const history = [];
      const RAKE_DEN = 10n; // coin-flip 10% rake

      const note = (ts) => { if (ts && (!memberSinceSec || ts < memberSinceSec)) memberSinceSec = ts; };
      const record = (game, won, betWei, payoutWei, ts) => {
        per[game]++;
        if (won) wins++; else losses++;
        wageredWei += betWei;
        const net = won ? (payoutWei - betWei) : -betWei;
        netWei += net;
        if (won && net > biggestWinWei) biggestWinWei = net;
        note(ts);
        history.push({ game, won, betWei, payoutWei, net, ts });
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
          const payout = pot - pot / RAKE_DEN; // winner takes pot minus 10%
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

      const played = wins + losses;
      // favorite = most-played game
      let favoriteGame = null, favCount = -1;
      for (const k in per) if (per[k] > favCount) { favCount = per[k]; favoriteGame = per[k] > 0 ? k : null; }

      history.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      return {
        per, played, wins, losses,
        winRate: played ? wins / played : 0,
        wageredWei, biggestWinWei, netWei,
        memberSinceSec,
        favoriteGame, favoriteGameLabel: favoriteGame ? GAMES[favoriteGame] : "—",
        history: history.slice(0, 25),
      };
    },
  };

  window.Profile = Profile;
})();
