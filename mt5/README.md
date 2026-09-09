# Sweep + EMA Trend + VWAP — MT5 Expert Advisor

`SweepEmaVwapEA.mq5` is a direct port of the TradingView Pine Script v6 strategy
"Sweep + EMA Trend + VWAP". Every entry condition, filter and exit rule is preserved.
This document records what maps one-to-one and where the two platforms cannot behave
identically.

## Install

1. Copy `SweepEmaVwapEA.mq5` into `MQL5/Experts/` inside the terminal data folder
   (File → Open Data Folder in MetaTrader 5).
2. Open it in MetaEditor and press F7 to compile.
3. Attach it to a chart, or select it in the Strategy Tester.

## Strategy logic (unchanged from Pine)

**Sweep detection**, evaluated on the last two closed candles of the signal timeframe:

- Long: previous candle bearish, current low below the previous low, current candle
  bullish, current close above the previous candle's body high.
- Short: previous candle bullish, current high above the previous high, current candle
  bearish, current close below the previous candle's body low.

**Filters**: any combination of the three EMAs (price on the correct side of every
enabled EMA, and correct ordering between every enabled pair), an optional daily-reset
VWAP filter, and an optional session filter combining Asian, London, New York and custom
windows.

**Levels**: entry is the sweep candle's close. The stop is the sweep candle's low minus
(or high plus) the pip buffer. TP1 and TP2 are multiples of that entry-to-stop risk.

**Management**: a percentage of the position closes at TP1, the remainder targets TP2,
and the stop optionally moves to entry after TP1. One trade at a time, matching
`pyramiding = 0`.

## Platform differences you should know about

| Topic | Pine | This EA |
| --- | --- | --- |
| Entry timing | `process_orders_on_close` fills at the close of the bar after the sweep candle | `Replicate TradingView one-bar entry lag = true` reproduces that exactly; set it false to fill at the sweep candle's close instead |
| TP1 detection | Bar high/low while the position is open | Bid/Ask on every tick |
| Partial close | Two `strategy.exit` legs | One position, partially closed at TP1, stop then moved to entry |
| VWAP | Session VWAP on the signal timeframe, `hlc3 * volume`, daily reset | Same formula, real volume when the broker supplies it and tick volume otherwise, reset at server-time midnight |
| Session timezone | IANA zone from the exchange calendar | Broker server time converted to GMT with the offset you supply, then to the selected zone; London and New York apply EU and US daylight-saving rules |
| Position size | 1 contract | Fixed lots, or lots derived from a risk percentage of balance |
| Drawing | Boxes, lines and labels | Rectangles, trend lines and text objects for each trade; the EMAs and VWAP are not plotted, since an EA has no indicator buffers |

Broker constraints have no Pine equivalent and are handled defensively: a signal is
skipped when the stop or target is closer than the broker's stops level, when the spread
exceeds the optional cap, or when trading is disabled. Each skip is written to the
Experts log.

## Settings that need attention before a long backtest

- **Broker Server GMT Offset** only matters when the session filter is on. Most brokers
  run at UTC+2 in winter and UTC+3 in summer, which is the default (offset 2, DST on).
  Check your broker and correct it, otherwise the session windows shift by hours.
- **Manual Pip Size** applies when automatic pip sizing is off. Automatic sizing gives
  0.0001 on five and four digit forex pairs, 0.01 on three and two digit JPY pairs, and
  one point on everything else, which is what XAUUSD and indices usually need.
- **Fixed Lot Size** must be at least twice the symbol's minimum lot for the TP1 partial
  close to be possible. With a 0.01 minimum, use 0.02 or more. If the volume cannot be
  split the EA logs a warning, holds the full position to TP2, and still moves to
  break-even.
- **Magic Number** isolates this EA's positions. Change it if you run several instances.

## Backtesting

Use "Every tick based on real ticks" where your broker provides tick data; otherwise
"Every tick". Both TP1 detection and break-even management run on ticks, so the M1 OHLC
model will misprice them.

Run the chart timeframe equal to the signal timeframe unless you deliberately want the
Pine higher-timeframe behaviour, in which case set the signal timeframe higher than the
chart and keep the bar-lag option on.

To compare results against TradingView, keep the one-bar entry lag enabled, set
commission to zero, and remember that spread handling differs: Pine fills both sides at
the same price, MT5 buys at the ask and sells at the bid.
