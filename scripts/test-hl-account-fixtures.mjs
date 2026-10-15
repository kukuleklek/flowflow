/**
 * test-hl-account-fixtures — the LIVE Hyperliquid answers the account suites
 * are pinned to, plus one test that the capture is still what it claims.
 *
 *   node --test scripts/test-hl-account-fixtures.mjs
 *
 * Every object below was captured READ-ONLY on 2026-09-22 from public mainnet
 * endpoints (POST https://api.hyperliquid.xyz/info with read-only bodies, and
 * one short wss subscription session). No order, transfer or signature was
 * sent. The addresses are public traders found through recentTrades:
 *
 *   A      unifiedAccount, 6 main-dex positions, 7 normal TP/SL trigger orders,
 *          1775 fills (under the 2000 cap), one CCTP deposit line, and one
 *          isolated xyz:HOOD position on the HIP-3 dex "xyz"
 *   B      disabled (standard), 2 short positions, spot USDC held separately
 *   C      one isolated BTC short with a POSITION TP/SL whose size is "0.0"
 *   FRESH  a random never-used address: role "missing", mode "default"
 *   D      a live "default"-mode trader (6 of 6 such traders measured keep
 *          their USDC in the perp clearinghouse, none in spot)
 *
 * Arrays are trimmed where noted; summaries and the rows kept are verbatim.
 * perpDexs keeps only the names (the rest of that answer is market config).
 *
 * The suites import this module; its own test runs only when it is the file
 * node --test was asked to run, so importing it adds no tests elsewhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// Captured read-only from https://api.hyperliquid.xyz on 2026-09-22 (capture ms 1790070455424).
export const CAPTURED_AT = 1790070455424;
export const ADDR = {"A": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "B": "0xeb473272fe8aff61d97fb974422966391f3c25be", "C": "0xb4c19bcd0887c8f5e523c9f8f931b74cc722c7c1", "FRESH": "0x6cdea1a4bb185d38836b34b1659b0e453bef3b9d", "D": "0x6ce8a609b7e76d22b3cf477c16453ef9ec9a188a"};

export const A = {
  userAbstraction: "unifiedAccount",
  userRole: {"role": "user"},
  clearinghouseState: {"marginSummary": {"accountValue": "109825.54706", "totalNtlPos": "1081060.587844", "totalRawUsd": "-971235.040784", "totalMarginUsed": "66965.038903"}, "crossMarginSummary": {"accountValue": "109825.54706", "totalNtlPos": "1081060.587844", "totalRawUsd": "-971235.040784", "totalMarginUsed": "66965.038903"}, "crossMaintenanceMarginUsed": "32283.813808", "withdrawable": "0.0", "time": 1790070457694, "assetPositions": [
      {"type": "oneWay", "position": {"coin": "BTC", "szi": "4.81064", "leverage": {"type": "cross", "value": 40}, "entryPx": "80926.7", "positionValue": "414330.80192", "unrealizedPnl": "25021.102078", "returnOnEquity": "2.5708172273", "liquidationPx": "61092.0544535562", "marginUsed": "10358.270048", "maxLeverage": 40, "cumFunding": {"allTime": "841.398435", "sinceOpen": "693.73039", "sinceChange": "44.510097"}}},
      {"type": "oneWay", "position": {"coin": "ETH", "szi": "87.2738", "leverage": {"type": "cross", "value": 20}, "entryPx": "2728.66", "positionValue": "239741.1286", "unrealizedPnl": "1600.567537", "returnOnEquity": "0.134422085", "liquidationPx": "1356.4263396299", "marginUsed": "11987.05643", "maxLeverage": 25, "cumFunding": {"allTime": "109.574721", "sinceOpen": "109.574721", "sinceChange": "43.402819"}}},
      {"type": "oneWay", "position": {"coin": "NEAR", "szi": "36110.3", "leverage": {"type": "cross", "value": 10}, "entryPx": "4.1678", "positionValue": "162182.19039", "unrealizedPnl": "11681.553719", "returnOnEquity": "0.7761796878", "liquidationPx": "1.0243365846", "marginUsed": "16218.219039", "maxLeverage": 10, "cumFunding": {"allTime": "381.900022", "sinceOpen": "381.900022", "sinceChange": "0.0"}}},
      {"type": "oneWay", "position": {"coin": "AR", "szi": "4426.22", "leverage": {"type": "cross", "value": 5}, "entryPx": "4.6187", "positionValue": "19208.466934", "unrealizedPnl": "-1234.919536", "returnOnEquity": "-0.3020339947", "liquidationPx": null, "marginUsed": "3841.693386", "maxLeverage": 5, "cumFunding": {"allTime": "6.040571", "sinceOpen": "6.040571", "sinceChange": "2.076381"}}},
      {"type": "oneWay", "position": {"coin": "HYPE", "szi": "1000.0", "leverage": {"type": "cross", "value": 10}, "entryPx": "95.0674", "positionValue": "95118.0", "unrealizedPnl": "50.59353", "returnOnEquity": "0.0053218587", "liquidationPx": null, "marginUsed": "9511.8", "maxLeverage": 10, "cumFunding": {"allTime": "0.0", "sinceOpen": "0.0", "sinceChange": "0.0"}}},
      {"type": "oneWay", "position": {"coin": "ZEC", "szi": "100.0", "leverage": {"type": "cross", "value": 10}, "entryPx": "1499.4185", "positionValue": "150480.0", "unrealizedPnl": "538.145", "returnOnEquity": "0.0358902456", "liquidationPx": "252.8691097895", "marginUsed": "15048.0", "maxLeverage": 10, "cumFunding": {"allTime": "0.0", "sinceOpen": "0.0", "sinceChange": "0.0"}}},
    ]},
  spotClearinghouseState: {"balances": [{"coin": "USDC", "token": 0, "total": "155293.727137", "hold": "114127.591702", "entryNtl": "0.0"}, {"coin": "USDE", "token": 235, "total": "0.0", "hold": "0.0", "entryNtl": "0.0"}, {"coin": "USDT0", "token": 268, "total": "0.0", "hold": "0.0", "entryNtl": "0.0"}, {"coin": "USDH", "token": 360, "total": "0.0", "hold": "0.0", "entryNtl": "0.0"}], "tokenToAvailableAfterMaintenance": [[0, "118907.833065"]]},
  frontendOpenOrders: [
    {"coin": "ZEC", "side": "A", "limitPx": "1287.0", "sz": "30.0", "oid": 552794034828, "timestamp": 1790069152237, "triggerCondition": "Price below 1430", "isTrigger": true, "triggerPx": "1430.0", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Stop Market", "origSz": "30.0", "tif": null, "cloid": null},
    {"coin": "NEAR", "side": "A", "limitPx": "6.66", "sz": "5000.0", "oid": 552789268425, "timestamp": 1790068741894, "triggerCondition": "Price above 7.4", "isTrigger": true, "triggerPx": "7.4", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Take Profit Market", "origSz": "5000.0", "tif": null, "cloid": null},
    {"coin": "NEAR", "side": "A", "limitPx": "3.393", "sz": "4000.0", "oid": 552319467239, "timestamp": 1790034350410, "triggerCondition": "Price below 3.77", "isTrigger": true, "triggerPx": "3.77", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Stop Market", "origSz": "4000.0", "tif": null, "cloid": null},
    {"coin": "NEAR", "side": "A", "limitPx": "3.465", "sz": "4000.0", "oid": 552317696925, "timestamp": 1790034179281, "triggerCondition": "Price below 3.85", "isTrigger": true, "triggerPx": "3.85", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Stop Market", "origSz": "4000.0", "tif": null, "cloid": null},
    {"coin": "NEAR", "side": "A", "limitPx": "3.555", "sz": "4000.0", "oid": 552317582137, "timestamp": 1790034167051, "triggerCondition": "Price below 3.95", "isTrigger": true, "triggerPx": "3.95", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Stop Market", "origSz": "4000.0", "tif": null, "cloid": null},
    {"coin": "ETH", "side": "A", "limitPx": "2421.0", "sz": "20.0", "oid": 552316055727, "timestamp": 1790034013753, "triggerCondition": "Price below 2690", "isTrigger": true, "triggerPx": "2690.0", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Stop Market", "origSz": "20.0", "tif": null, "cloid": null},
    {"coin": "ETH", "side": "A", "limitPx": "2439.0", "sz": "20.0", "oid": 552315912026, "timestamp": 1790034002611, "triggerCondition": "Price below 2710", "isTrigger": true, "triggerPx": "2710.0", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Stop Market", "origSz": "20.0", "tif": null, "cloid": null},
  ],
  userFillsNewest6: [
    {"coin": "AR", "px": "4.3647", "sz": "1701.73", "side": "A", "time": 1790050836532, "startPosition": "6127.95", "dir": "Close Long", "closedPnl": "-432.23942", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "2.852175", "tid": 853691299394113, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3653", "sz": "23.43", "side": "A", "time": 1790050836532, "startPosition": "6151.38", "dir": "Close Long", "closedPnl": "-5.937162", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.039275", "tid": 166007286822674, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3654", "sz": "24.14", "side": "A", "time": 1790050836532, "startPosition": "6175.52", "dir": "Close Long", "closedPnl": "-6.114662", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.040466", "tid": 40476499359691, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3655", "sz": "25.14", "side": "A", "time": 1790050836532, "startPosition": "6200.66", "dir": "Close Long", "closedPnl": "-6.365448", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.042143", "tid": 853460710937943, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3669", "sz": "806.06", "side": "A", "time": 1790050836532, "startPosition": "7006.72", "dir": "Close Long", "closedPnl": "-202.965908", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "1.351673", "tid": 628312002946639, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.369", "sz": "2.3", "side": "A", "time": 1790050836532, "startPosition": "7009.02", "dir": "Close Long", "closedPnl": "-0.57431", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.003858", "tid": 939598096880706, "feeToken": "USDC", "twapId": null},
  ],
  userFillsCount: 1775,
  /* userFillsByTime {startTime: the newest fill's time above}, read once more
     on 2026-09-22 (ms about 1790080099000), verbatim and complete: 16 fills.
     startTime is INCLUSIVE (every fill at that very millisecond comes back,
     10 more than the 6 kept above), the shape is userFills' own, and nothing
     newer had happened in the 8 hours since. */
  userFillsByTimeStart: 1790050836532,
  userFillsByTimeAtNewest: [
    {"coin": "AR", "px": "4.3746", "sz": "342.05", "side": "A", "time": 1790050836532, "startPosition": "9426.22", "dir": "Close Long", "closedPnl": "-83.494405", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.574591", "tid": 447811220943721, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3734", "sz": "55.18", "side": "A", "time": 1790050836532, "startPosition": "9084.17", "dir": "Close Long", "closedPnl": "-13.535654", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.092668", "tid": 997306259461679, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3723", "sz": "91.49", "side": "A", "time": 1790050836532, "startPosition": "9028.99", "dir": "Close Long", "closedPnl": "-22.543136", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.153608", "tid": 404486100637408, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3714", "sz": "2.48", "side": "A", "time": 1790050836532, "startPosition": "8937.5", "dir": "Close Long", "closedPnl": "-0.613304", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.004162", "tid": 9147435616433, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3699", "sz": "91.54", "side": "A", "time": 1790050836532, "startPosition": "8935.02", "dir": "Close Long", "closedPnl": "-22.775152", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.153607", "tid": 244784994087808, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3698", "sz": "60.99", "side": "A", "time": 1790050836532, "startPosition": "8843.48", "dir": "Close Long", "closedPnl": "-15.180411", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.102341", "tid": 1016759231012089, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3696", "sz": "91.54", "side": "A", "time": 1790050836532, "startPosition": "8782.49", "dir": "Close Long", "closedPnl": "-22.802614", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.153597", "tid": 998979204892477, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3695", "sz": "342.05", "side": "A", "time": 1790050836532, "startPosition": "8690.95", "dir": "Close Long", "closedPnl": "-85.23886", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.573921", "tid": 903982176558957, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3695", "sz": "66.48", "side": "A", "time": 1790050836532, "startPosition": "8348.9", "dir": "Close Long", "closedPnl": "-16.566816", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.111545", "tid": 736227706739603, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3691", "sz": "1273.4", "side": "A", "time": 1790050836532, "startPosition": "8282.42", "dir": "Close Long", "closedPnl": "-317.84064", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "2.136426", "tid": 173237190586271, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.369", "sz": "2.3", "side": "A", "time": 1790050836532, "startPosition": "7009.02", "dir": "Close Long", "closedPnl": "-0.57431", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.003858", "tid": 939598096880706, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3669", "sz": "806.06", "side": "A", "time": 1790050836532, "startPosition": "7006.72", "dir": "Close Long", "closedPnl": "-202.965908", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "1.351673", "tid": 628312002946639, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3655", "sz": "25.14", "side": "A", "time": 1790050836532, "startPosition": "6200.66", "dir": "Close Long", "closedPnl": "-6.365448", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.042143", "tid": 853460710937943, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3654", "sz": "24.14", "side": "A", "time": 1790050836532, "startPosition": "6175.52", "dir": "Close Long", "closedPnl": "-6.114662", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.040466", "tid": 40476499359691, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3653", "sz": "23.43", "side": "A", "time": 1790050836532, "startPosition": "6151.38", "dir": "Close Long", "closedPnl": "-5.937162", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.039275", "tid": 166007286822674, "feeToken": "USDC", "twapId": null},
    {"coin": "AR", "px": "4.3647", "sz": "1701.73", "side": "A", "time": 1790050836532, "startPosition": "6127.95", "dir": "Close Long", "closedPnl": "-432.23942", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "2.852175", "tid": 853691299394113, "feeToken": "USDC", "twapId": null},
  ],
  userNonFundingLedgerUpdates: [
    {"time": 1789606962368, "hash": "0x84410b2d628fbd4285ba044490bd4000007c2312fd82dc142809b6802183972d", "delta": {"type": "send", "user": "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24", "destination": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "sourceDex": "spot", "destinationDex": "", "token": "USDC", "amount": "50137.38", "usdcValue": "50137.38", "fee": "0.0", "nativeTokenFee": "0.0", "nonce": 3362845, "feeToken": ""}},
  ],
  /* activeAssetData for SOL, read in the same session as MEASURED.availableVsFree */
  activeAssetDataSOL: {"user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "coin": "SOL", "leverage": {"type": "cross", "value": 20}, "maxTradeSzs": ["14516.26", "14516.26"], "availableToTrade": ["85261.294132", "85261.294132"], "markPx": "117.47"},
  /* A's OWN venue open orders. Measured 2026-09-23, POST /info
     {type:"frontendOpenOrders", user, dex:"xyz"}: the SAME shape as the main
     dex's, with a qualified coin name. Row 1 is verbatim from that day's answer
     for a public trader on the xyz dex (a resting Alo limit — no trigger order
     was open on any venue at the time of the read). Row 2 is C's REAL main-dex
     position TP/SL row with its coin changed to a venue name, which is the whole
     point of the row: it proves classifyTpSlOrders reaches a venue's triggers
     now that they are in the list at all.
     Measured the same day, with no dex in the body: 0 of one address's 380 venue
     orders came back. That is why the dex has to be asked for. */
  xyzFrontendOpenOrders: [
    {"coin": "xyz:META", "side": "A", "limitPx": "758.73", "sz": "6.704", "oid": 554387163576, "timestamp": 1790181244091, "triggerCondition": "N/A", "isTrigger": false, "triggerPx": "0.0", "children": [], "isPositionTpsl": false, "reduceOnly": false, "orderType": "Limit", "origSz": "6.704", "tif": "Alo", "cloid": "0x0000000000000000862445eb9a295e6f"},
    {"coin": "xyz:HOOD", "side": "A", "limitPx": "95.0", "sz": "0.0", "oid": 554387163577, "timestamp": 1790070413384, "triggerCondition": "Price below 100", "isTrigger": true, "triggerPx": "100.0", "children": [], "isPositionTpsl": true, "reduceOnly": true, "orderType": "Stop Market", "origSz": "0.0", "tif": null, "cloid": null},
  ],
  xyzClearinghouseState: {"marginSummary": {"accountValue": "4139.403823", "totalNtlPos": "19952.31572", "totalRawUsd": "-15812.911897", "totalMarginUsed": "4139.403823"}, "crossMarginSummary": {"accountValue": "0.0", "totalNtlPos": "0.0", "totalRawUsd": "0.0", "totalMarginUsed": "0.0"}, "crossMaintenanceMarginUsed": "0.0", "withdrawable": "0.0", "time": 1790070958656, "assetPositions": [
      {"type": "oneWay", "position": {"coin": "xyz:HOOD", "szi": "163.316", "leverage": {"type": "isolated", "value": 10, "rawUsd": "-15812.911897"}, "entryPx": "107.423", "positionValue": "19952.31572", "unrealizedPnl": "2408.273295", "returnOnEquity": "1.372701477", "liquidationPx": "101.9200226426", "marginUsed": "4139.403823", "maxLeverage": 10, "cumFunding": {"allTime": "30.895802", "sinceOpen": "30.895802", "sinceChange": "3.730954"}}},
    ]},
};

export const B = {
  userAbstraction: "disabled",
  clearinghouseState: {"marginSummary": {"accountValue": "2900.93691", "totalNtlPos": "30980.78672", "totalRawUsd": "33881.72363", "totalMarginUsed": "1173.327468"}, "crossMarginSummary": {"accountValue": "2900.93691", "totalNtlPos": "30980.78672", "totalRawUsd": "33881.72363", "totalMarginUsed": "1173.327468"}, "crossMaintenanceMarginUsed": "586.663734", "withdrawable": "0.0", "time": 1790070462510, "assetPositions": [
      {"type": "oneWay", "position": {"coin": "BTC", "szi": "-0.17449", "leverage": {"type": "cross", "value": 40}, "entryPx": "85802.4", "positionValue": "15028.47472", "unrealizedPnl": "-56.806386", "returnOnEquity": "-0.1517703565", "liquidationPx": "99227.3289141052", "marginUsed": "375.711868", "maxLeverage": 40, "cumFunding": {"allTime": "-26.654378", "sinceOpen": "-14.94601", "sinceChange": "0.0"}}},
      {"type": "oneWay", "position": {"coin": "SOL", "szi": "-135.88", "leverage": {"type": "cross", "value": 20}, "entryPx": "116.9871", "positionValue": "15952.312", "unrealizedPnl": "-56.102779", "returnOnEquity": "-0.0705863621", "liquidationPx": "134.016334183", "marginUsed": "797.6156", "maxLeverage": 20, "cumFunding": {"allTime": "-20.234607", "sinceOpen": "-8.06625", "sinceChange": "0.0"}}},
    ]},
  spotClearinghouseState: {"balances": [{"coin": "USDC", "token": 0, "total": "9380.04956985", "hold": "0.0", "entryNtl": "0.0"}, {"coin": "HYPE", "token": 150, "total": "0.99965", "hold": "0.0", "entryNtl": "68.285"}, {"coin": "DRV", "token": 843, "total": "17497.21675839", "hold": "4630.01", "entryNtl": "7134.88986846"}]},
  activeAssetDataETH: {"user": "0xeb473272fe8aff61d97fb974422966391f3c25be", "coin": "ETH", "leverage": {"type": "cross", "value": 25}, "maxTradeSzs": ["15.4857", "15.4857"], "availableToTrade": ["1703.800459", "1703.800459"], "markPx": "2750.6"},
};

export const C = {
  clearinghouseState: {"marginSummary": {"accountValue": "418.66173", "totalNtlPos": "15339.652506", "totalRawUsd": "15758.314236", "totalMarginUsed": "418.66173"}, "crossMarginSummary": {"accountValue": "0.0", "totalNtlPos": "0.0", "totalRawUsd": "0.0", "totalMarginUsed": "0.0"}, "crossMaintenanceMarginUsed": "0.0", "withdrawable": "0.0", "time": 1790070464322, "assetPositions": [
      {"type": "oneWay", "position": {"coin": "BTC", "szi": "-0.17811", "leverage": {"type": "isolated", "value": 36, "rawUsd": "15758.314236"}, "entryPx": "86118.9", "positionValue": "15339.652506", "unrealizedPnl": "-1.006416", "returnOnEquity": "-0.0023620713", "liquidationPx": "87382.8934179253", "marginUsed": "418.66173", "maxLeverage": 40, "cumFunding": {"allTime": "-27.03709", "sinceOpen": "0.0", "sinceChange": "0.0"}}},
    ]},
  frontendOpenOrders: [
    {"coin": "BTC", "side": "B", "limitPx": "95065.0", "sz": "0.0", "oid": 552810049453, "timestamp": 1790070413384, "triggerCondition": "Price above 86423", "isTrigger": true, "triggerPx": "86423.0", "children": [], "isPositionTpsl": true, "reduceOnly": true, "orderType": "Stop Market", "origSz": "0.0", "tif": null, "cloid": null},
  ],
};

export const FRESH = {
  userRole: {"role": "missing"},
  userAbstraction: "default",
  clearinghouseState: {"marginSummary": {"accountValue": "0.0", "totalNtlPos": "0.0", "totalRawUsd": "0.0", "totalMarginUsed": "0.0"}, "crossMarginSummary": {"accountValue": "0.0", "totalNtlPos": "0.0", "totalRawUsd": "0.0", "totalMarginUsed": "0.0"}, "crossMaintenanceMarginUsed": "0.0", "withdrawable": "0.0", "time": 1790070466367, "assetPositions": []},
  spotClearinghouseState: {"balances": []},
};

// A live "default"-mode trader (assetPositions trimmed to 2 of 13; summaries untouched).
export const DEFAULT_MODE = {
  userAbstraction: "default",
  clearinghouseState: {"marginSummary": {"accountValue": "109945.428951", "totalNtlPos": "434202.312572", "totalRawUsd": "544147.7415229999", "totalMarginUsed": "38781.923672"}, "crossMarginSummary": {"accountValue": "109945.428951", "totalNtlPos": "434202.312572", "totalRawUsd": "544147.7415229999", "totalMarginUsed": "38781.923672"}, "crossMaintenanceMarginUsed": "19390.961833", "withdrawable": "61867.569553", "time": 1790070714981, "assetPositions": [
      {"type": "oneWay", "position": {"coin": "BTC", "szi": "-0.40983", "leverage": {"type": "cross", "value": 40}, "entryPx": "85111.4", "positionValue": "35285.95317", "unrealizedPnl": "-404.712983", "returnOnEquity": "-0.4641038918", "liquidationPx": "304327.3159681084", "marginUsed": "882.148829", "maxLeverage": 40, "cumFunding": {"allTime": "-25701.839294", "sinceOpen": "-16.531957", "sinceChange": "-2.914177"}}},
      {"type": "oneWay", "position": {"coin": "ETH", "szi": "-35.373", "leverage": {"type": "cross", "value": 25}, "entryPx": "2543.11", "positionValue": "97151.9445", "unrealizedPnl": "-7194.203764", "returnOnEquity": "-1.999328714", "liquidationPx": "5256.2924782001", "marginUsed": "3886.07778", "maxLeverage": 25, "cumFunding": {"allTime": "-9957.070734", "sinceOpen": "-1391.668223", "sinceChange": "-9.682215"}}},
    ]},
  spotClearinghouseState: {"balances": []},
};

// WebSocket pushes, full frames as received (arrays trimmed where noted).
export const WS = {
  webData3A: {"channel": "webData3", "data": {"userState": {"agentAddress": "0x460152803c358e0944f6b0bd6576542219947ce8", "agentValidUntil": 1790816563551, "cumLedger": "50137.38", "serverTime": 1790070599773, "isVault": false, "user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "dexAbstractionEnabled": false, "abstraction": "unifiedAccount"}, "perpDexStates": [{"totalVaultEquity": "0.0", "perpsAtOpenInterestCap": ["CANTO", "FTM", "HMSTR", "JELLY", "LOOM", "RLB", "SAGA", "VINE", "ZEREBRO"]}, {"totalVaultEquity": "0.0", "perpsAtOpenInterestCap": ["xyz:AVGO"]}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}]}},
  webData3Fresh: {"channel": "webData3", "data": {"userState": {"agentAddress": null, "agentValidUntil": null, "cumLedger": "0.0", "serverTime": 1790070599839, "isVault": false, "user": "0x6cdea1a4bb185d38836b34b1659b0e453bef3b9d"}, "perpDexStates": [{"totalVaultEquity": "0.0", "perpsAtOpenInterestCap": ["CANTO", "FTM", "HMSTR", "JELLY", "LOOM", "RLB", "SAGA", "VINE", "ZEREBRO"]}, {"totalVaultEquity": "0.0", "perpsAtOpenInterestCap": ["xyz:AVGO"]}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}, {"totalVaultEquity": "0.0"}]}},
  clearinghouseStateA: {"channel": "clearinghouseState", "data": {"dex": "", "user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "clearinghouseState": {"marginSummary": {"accountValue": "111021.489471", "totalNtlPos": "1084332.2169910001", "totalRawUsd": "-973310.72752", "totalMarginUsed": "67300.0902"}, "crossMarginSummary": {"accountValue": "111021.489471", "totalNtlPos": "1084332.2169910001", "totalRawUsd": "-973310.72752", "totalMarginUsed": "67300.0902"}, "crossMaintenanceMarginUsed": "32451.514004", "withdrawable": "670.298123", "time": 1790070599773, "assetPositions": [
      {"type": "oneWay", "position": {"coin": "BTC", "szi": "4.81064", "leverage": {"type": "cross", "value": 40}, "entryPx": "80926.7", "positionValue": "414210.53592", "unrealizedPnl": "24900.836078", "returnOnEquity": "2.5584603813", "liquidationPx": "61033.2943490032", "marginUsed": "10355.263398", "maxLeverage": 40, "cumFunding": {"allTime": "841.398435", "sinceOpen": "693.73039", "sinceChange": "44.510097"}}},
      {"type": "oneWay", "position": {"coin": "ETH", "szi": "87.2738", "leverage": {"type": "cross", "value": 20}, "entryPx": "2728.66", "positionValue": "239706.21908", "unrealizedPnl": "1565.658017", "returnOnEquity": "0.1314902434", "liquidationPx": "1354.1511992682", "marginUsed": "11985.310954", "maxLeverage": 25, "cumFunding": {"allTime": "109.574721", "sinceOpen": "109.574721", "sinceChange": "43.402819"}}},
      {"type": "oneWay", "position": {"coin": "NEAR", "szi": "36766.1", "leverage": {"type": "cross", "value": 10}, "entryPx": "4.17349", "positionValue": "165545.615487", "unrealizedPnl": "12102.557366", "returnOnEquity": "0.7887328051", "liquidationPx": "1.0929554107", "marginUsed": "16554.561548", "maxLeverage": 10, "cumFunding": {"allTime": "381.900022", "sinceOpen": "381.900022", "sinceChange": "0.0"}}},
      {"type": "oneWay", "position": {"coin": "AR", "szi": "4426.22", "leverage": {"type": "cross", "value": 5}, "entryPx": "4.6187", "positionValue": "19179.696504", "unrealizedPnl": "-1263.689966", "returnOnEquity": "-0.3090706053", "liquidationPx": null, "marginUsed": "3835.9393", "maxLeverage": 5, "cumFunding": {"allTime": "6.040571", "sinceOpen": "6.040571", "sinceChange": "2.076381"}}},
      {"type": "oneWay", "position": {"coin": "HYPE", "szi": "1000.0", "leverage": {"type": "cross", "value": 10}, "entryPx": "95.0674", "positionValue": "95132.0", "unrealizedPnl": "64.59353", "returnOnEquity": "0.006794498", "liquidationPx": null, "marginUsed": "9513.2", "maxLeverage": 10, "cumFunding": {"allTime": "0.0", "sinceOpen": "0.0", "sinceChange": "0.0"}}},
      {"type": "oneWay", "position": {"coin": "ZEC", "szi": "100.0", "leverage": {"type": "cross", "value": 10}, "entryPx": "1499.4185", "positionValue": "150558.15", "unrealizedPnl": "616.295", "returnOnEquity": "0.0411022659", "liquidationPx": "251.9624243895", "marginUsed": "15055.815", "maxLeverage": 10, "cumFunding": {"allTime": "0.0", "sinceOpen": "0.0", "sinceChange": "0.0"}}},
    ]}}},
  spotStateA: {"channel": "spotState", "data": {"user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "spotState": {"balances": [{"coin": "USDC", "token": 0, "total": "155650.43365", "hold": "114456.298811", "entryNtl": "0.0"}, {"coin": "USDE", "token": 235, "total": "0.0", "hold": "0.0", "entryNtl": "0.0"}, {"coin": "USDT0", "token": 268, "total": "0.0", "hold": "0.0", "entryNtl": "0.0"}, {"coin": "USDH", "token": 360, "total": "0.0", "hold": "0.0", "entryNtl": "0.0"}], "tokenToAvailableAfterMaintenance": [[0, "119093.812183"]]}}},
  openOrdersA_first2: {"channel": "openOrders", "data": {"dex": "", "user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "orders": [
      {"coin": "ZEC", "side": "A", "limitPx": "1287.0", "sz": "30.0", "oid": 552794034828, "timestamp": 1790069152237, "triggerCondition": "Price below 1430", "isTrigger": true, "triggerPx": "1430.0", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Stop Market", "origSz": "30.0", "tif": null, "cloid": null},
      {"coin": "NEAR", "side": "A", "limitPx": "6.66", "sz": "5000.0", "oid": 552789268425, "timestamp": 1790068741894, "triggerCondition": "Price above 7.4", "isTrigger": true, "triggerPx": "7.4", "children": [], "isPositionTpsl": false, "reduceOnly": true, "orderType": "Take Profit Market", "origSz": "5000.0", "tif": null, "cloid": null},
    ]}},
  /* The WS snapshot arrives OLDEST first (REST answers newest first); these
     are its 4 fills that are also among the REST newest 6. */
  userFillsSnapshotA_4overlapping: {"channel": "userFills", "data": {"isSnapshot": true, "user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "fills": [
      {"coin": "AR", "px": "4.3655", "sz": "25.14", "side": "A", "time": 1790050836532, "startPosition": "6200.66", "dir": "Close Long", "closedPnl": "-6.365448", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.042143", "tid": 853460710937943, "feeToken": "USDC", "twapId": null},
      {"coin": "AR", "px": "4.3654", "sz": "24.14", "side": "A", "time": 1790050836532, "startPosition": "6175.52", "dir": "Close Long", "closedPnl": "-6.114662", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.040466", "tid": 40476499359691, "feeToken": "USDC", "twapId": null},
      {"coin": "AR", "px": "4.3653", "sz": "23.43", "side": "A", "time": 1790050836532, "startPosition": "6151.38", "dir": "Close Long", "closedPnl": "-5.937162", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "0.039275", "tid": 166007286822674, "feeToken": "USDC", "twapId": null},
      {"coin": "AR", "px": "4.3647", "sz": "1701.73", "side": "A", "time": 1790050836532, "startPosition": "6127.95", "dir": "Close Long", "closedPnl": "-432.23942", "hash": "0x09d09d6eb8a5c4860b4a0444ef9d4a00000bb55453a8e358ad9948c177a99e70", "oid": 552361865727, "crossed": true, "fee": "2.852175", "tid": 853691299394113, "feeToken": "USDC", "twapId": null},
    ]}},
  /* A VENUE'S OWN STREAMS. Measured 2026-09-23 over a short wss session: both
     subscriptions are accepted and push live. clearinghouseState arrives as
     {dex, user, clearinghouseState} and openOrders as {dex, user, orders} — the
     SAME frames the main dex uses, told apart only by data.dex, which is exactly
     why every handler has to check it (store.js onStream). The main dex's own
     pushes carry dex "" in the same session.
     The bodies here are A's own captured venue state and venue orders, wrapped in
     that measured frame; accountValue is nudged so a test can tell a push from
     the REST answer it replaces. */
  clearinghouseStateXyzA: {"channel": "clearinghouseState", "data": {"dex": "xyz", "user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "clearinghouseState": {"marginSummary": {"accountValue": "4200.0", "totalNtlPos": "19952.31572", "totalRawUsd": "-15812.911897", "totalMarginUsed": "4139.403823"}, "crossMarginSummary": {"accountValue": "0.0", "totalNtlPos": "0.0", "totalRawUsd": "0.0", "totalMarginUsed": "0.0"}, "crossMaintenanceMarginUsed": "0.0", "withdrawable": "60.596177", "time": 1790071000000, "assetPositions": [
      {"type": "oneWay", "position": {"coin": "xyz:TSLA", "szi": "363.829", "leverage": {"type": "cross", "value": 20}, "entryPx": "379.667", "positionValue": "138335.06238", "unrealizedPnl": "200.905252", "returnOnEquity": "0.0290884248", "liquidationPx": null, "marginUsed": "6916.753119", "maxLeverage": 20, "cumFunding": {"allTime": "1422.279529", "sinceOpen": "876.514798", "sinceChange": "0.0"}}},
    ]}}},
  openOrdersXyzA: {"channel": "openOrders", "data": {"dex": "xyz", "user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "orders": [
      {"coin": "xyz:TSLA", "side": "A", "limitPx": "360.0", "sz": "0.0", "oid": 554387163999, "timestamp": 1790071000000, "triggerCondition": "Price below 365", "isTrigger": true, "triggerPx": "365.0", "children": [], "isPositionTpsl": true, "reduceOnly": true, "orderType": "Stop Market", "origSz": "0.0", "tif": null, "cloid": null},
    ]}},
  userFillsSnapshotSize: 30,
  ledgerSnapshotA: {"channel": "userNonFundingLedgerUpdates", "data": {"isSnapshot": true, "user": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "nonFundingLedgerUpdates": [{"time": 1789606962368, "hash": "0x84410b2d628fbd4285ba044490bd4000007c2312fd82dc142809b6802183972d", "delta": {"type": "send", "user": "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24", "destination": "0x9895ea2d96cb41d03f6efc76def2ae0186254734", "sourceDex": "spot", "destinationDex": "", "token": "USDC", "amount": "50137.38", "usdcValue": "50137.38", "fee": "0.0", "nativeTokenFee": "0.0", "nonce": 3362845, "feeToken": ""}}]}},
};

/* perpDexs, names only: index 0 is the main dex (null). */
export const PERP_DEXS = [null, { name: "xyz" }, { name: "flx" }, { name: "vntl" }, { name: "hyna" }, { name: "km" }, { name: "abcd" }, { name: "cash" }, { name: "para" }, { name: "mkts" }, { name: "io" }];

/* Measured during the capture, for the balance suite (not answers to replay). */
export const MEASURED = {
  /* A unified: spot USDC total and the main-dex accountValue moved by the same
     amount between consecutive pushes (-8.22 / -8.23 and -91.11 / -91.10), so
     the spot total carries unrealized P&L: it is the account's USDC equity. */
  unifiedCoMove: [
    { spotTotal: 155642.206881, accountValue: 111013.262702 },
    { spotTotal: 155551.100106, accountValue: 110922.155927 },
  ],
  /* A unified, same account: REST withdrawable "0.0", WS withdrawable
     "670.298123" seconds apart: the perp withdrawable is not meaningful in
     unified mode, exactly as the account-abstraction page warns. */
  unifiedPerpWithdrawable: { rest: 0, ws: 670.298123 },
  /* The free USDC (perpBalanceUsdc.availableUsdc) is NOT what a new order may
     use; they answer different questions. Read seconds apart:
       A (unified)  spot total 156799.036977 minus hold 114632.997805 is
                    42166.039172 free; activeAssetData on SOL says
                    85261.294132 available to trade.
       B (standard) withdrawable 0.0; activeAssetData on ETH says 1703.800459
                    available to trade.
     A trade ticket that showed the free figure as "available" would have
     told B there was nothing to trade with. */
  availableVsFree: {
    A: { spotTotal: 156799.036977, spotHold: 114632.997805, availableToTrade: 85261.294132 },
    B: { withdrawable: 0.0, availableToTrade: 1703.800459 },
  },
};

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  test("the fixtures are the live capture: shapes intact, numbers still strings, addresses lowercase", () => {
    for (const [k, a] of Object.entries(ADDR)) assert.match(a, /^0x[0-9a-f]{40}$/, k);
    assert.equal(A.userAbstraction, "unifiedAccount");
    assert.equal(B.userAbstraction, "disabled");
    assert.equal(FRESH.userAbstraction, "default");
    assert.deepEqual(FRESH.userRole, { role: "missing" });
    assert.equal(typeof A.clearinghouseState.marginSummary.accountValue, "string", "Hyperliquid sends numbers as strings");
    assert.equal(A.clearinghouseState.assetPositions.length, 6);
    assert.equal(A.clearinghouseState.assetPositions[3].position.liquidationPx, null, "AR: Hyperliquid's own null");
    assert.equal(C.frontendOpenOrders[0].isPositionTpsl, true);
    assert.equal(A.xyzFrontendOpenOrders[0].coin, "xyz:META", "a venue order's coin arrives ALREADY qualified");
    assert.equal(A.xyzFrontendOpenOrders[0].tif, "Alo", "verbatim from the answer, tif and all");
    assert.equal(A.xyzClearinghouseState.assetPositions[0].position.coin, "xyz:HOOD");
    assert.equal(WS.clearinghouseStateXyzA.data.dex, "xyz", "a venue push is told apart by data.dex alone");
    assert.equal(WS.openOrdersXyzA.data.dex, "xyz");
    assert.equal(WS.clearinghouseStateA.data.dex, "", "and the main dex's own push carries the empty string");
    assert.equal(WS.openOrdersA_first2.data.dex, "");
    assert.equal(C.frontendOpenOrders[0].sz, "0.0", "a position TP/SL is sized 0: the whole position");
    assert.equal(WS.webData3A.data.userState.abstraction, "unifiedAccount");
    assert.equal("abstraction" in WS.webData3Fresh.data.userState, false, "a never-used address carries no abstraction in webData3");
    assert.equal(WS.userFillsSnapshotA_4overlapping.data.isSnapshot, true);
    assert.ok(A.userFillsCount < 2000);
    assert.deepEqual(FRESH.spotClearinghouseState, { balances: [] });
    const byTime = A.userFillsByTimeAtNewest;
    assert.equal(byTime.length, 16);
    assert.ok(byTime.every((f) => f.time === A.userFillsByTimeStart), "startTime is inclusive: the fills AT that millisecond come back");
    const tids = new Set(byTime.map((f) => f.tid));
    assert.ok(A.userFillsNewest6.every((f) => tids.has(f.tid)), "the same fills userFills answered, by trade id");
    assert.deepEqual(Object.keys(byTime[0]).sort(), Object.keys(A.userFillsNewest6[0]).sort(), "the shape is userFills' own");
  });
}
