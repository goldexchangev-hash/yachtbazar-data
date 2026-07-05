"use strict";
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
let found = null;
for (let bet=0.01; bet<=2; bet=round2(bet+0.01)) {
  for (let payoutFrac=0; payoutFrac<1; payoutFrac=round2(payoutFrac+0.001)) {
    const t = round2(100 - bet + payoutFrac);
    const net = round2(t - 100);
    if (net < 0 && net > -0.005) { found = {bet, payoutFrac, t, net}; break; }
  }
  if (found) break;
}
process.stdout.write("sub-cent residual via round2 arithmetic: " + (found ? JSON.stringify(found) : "NONE (every residual is a multiple of 0.01)") + "\n");
const netUnits = round2(99.99 - 100);
const lockedWei = 10n**18n;
const netCents = BigInt(Math.round(netUnits*100));
const buyInCents = BigInt(Math.round(100*100));
const netWei = (lockedWei*netCents)/buyInCents;
process.stdout.write("smallest reachable loss $0.01 -> netUnits=" + netUnits + " netCents=" + netCents.toString() + " netWei=" + netWei.toString() + "\n");
