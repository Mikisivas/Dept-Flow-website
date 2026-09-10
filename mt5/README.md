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
| Session timezone | IANA zone from the exchange calendar | Server time converted to GMT with the offset you supply, then to the target zone; New York applies US rules and London applies EU/UK rules, per session window |
| Position size | 1 contract | Fixed lots, or lots derived from a risk percentage of balance |
| Drawing | Boxes, lines and labels | Rectangles, trend lines and text objects for each trade; the EMAs and VWAP are not plotted, since an EA has no indicator buffers |

Broker constraints have no Pine equivalent and are handled defensively: a signal is
skipped when the stop or target is closer than the broker's stops level, when the spread
exceeds the optional cap, or when trading is disabled. Each skip is written to the
Experts log.

## Settings that need attention before a long backtest

- **Broker Server GMT Offset** is 0 with DST shifting off, which is correct for Exness.
  The offset is an input, not a constant, so any other broker works by changing it. The
  EA prints its resolved clocks at startup and, on a live chart, warns when the offset
  you set disagrees with what the terminal reports.
- **Manual Pip Size** applies when automatic pip sizing is off. Automatic sizing gives
  0.0001 on five and four digit forex pairs, 0.01 on three and two digit JPY pairs, and
  one point on everything else, which is what XAUUSD and indices usually need.
- **Fixed Lot Size** must be at least twice the symbol's minimum lot for the TP1 partial
  close to be possible. With a 0.01 minimum, use 0.02 or more. If the volume cannot be
  split the EA logs a warning, holds the full position to TP2, and still moves to
  break-even.
- **Magic Number** isolates this EA's positions. Change it if you run several instances.

## Session timezones

Windows are defined as `HHMM-HHMM` clock times in a target zone, and the EA converts
server time to that zone on every evaluation. The default zone is **America/New_York**,
so all four windows are read as New York local time unless you override them.

Each window can carry its own zone through the Asian, London, New York and Custom
timezone inputs. `Use default session timezone` keeps it on New York.

The shipped defaults are the three main sessions written on a New York clock:

| Window | Default | Equivalent |
| --- | --- | --- |
| Asian | `1900-0300` | Tokyo 08:00-16:00 |
| London | `0300-1100` | London 08:00-16:00 |
| New York | `0800-1600` | New York cash hours |
| Custom | 08:00-12:00 | New York morning |

The Asian window crosses midnight, which the filter handles as a wrap-around.

Conversion is calendar-based rather than a fixed offset:

- **New York** switches on the second Sunday of March at 02:00 local and back on the
  first Sunday of November at 02:00 local.
- **London** switches on the last Sunday of March and back on the last Sunday of October,
  both at 01:00 UTC.

Those dates do not coincide, so for roughly two weeks in March and one week in
October/November, London sits four or six hours ahead of New York instead of five. Tokyo
keeps no daylight time at all, so it moves against New York for the whole US winter.

Measured against each session's home-zone hours across 2026, the New York clock defaults
drift by:

| Window | Drift per year |
| --- | --- |
| New York | 0 hours |
| London | 56 hours |
| Asian | 254 hours |

The London figure is only the DST-mismatch weeks. The Asian figure is the whole US
winter, when `1900-0300` New York time is Tokyo 09:00-17:00 rather than 08:00-16:00. To
remove either drift, set that window's timezone input to its home zone and write the
hours locally: Asian as Asia/Tokyo `0800-1600`, London as Europe/London `0800-1600`.

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
