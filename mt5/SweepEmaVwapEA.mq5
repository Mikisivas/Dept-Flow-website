//+------------------------------------------------------------------+
//|                                               SweepEmaVwapEA.mq5 |
//|        MT5 port of the "Sweep + EMA Trend + VWAP Strategy"       |
//|                        (TradingView Pine Script v6)              |
//|                                                                  |
//|  This Source Code Form is subject to the terms of the Mozilla    |
//|  Public License 2.0 at https://mozilla.org/MPL/2.0/  MPL-2.0     |
//+------------------------------------------------------------------+
#property copyright "MPL-2.0"
#property link      "https://mozilla.org/MPL/2.0/"
#property version   "1.00"
#property description "Sweep + EMA Trend + VWAP. Liquidity sweep entries filtered by EMA trend,"
#property description "VWAP and trading sessions, with TP1 partial close and break-even management."

#include <Trade/Trade.mqh>

//+------------------------------------------------------------------+
//| Enumerations                                                     |
//+------------------------------------------------------------------+
enum ENUM_SESSION_TZ
  {
   TZ_LAGOS,      // Africa/Lagos (UTC+1)
   TZ_UTC,        // Etc/UTC
   TZ_LONDON,     // Europe/London (GMT/BST, EU-UK rules)
   TZ_NEWYORK,    // America/New_York (EST/EDT, US rules)
   TZ_TOKYO,      // Asia/Tokyo (UTC+9)
   TZ_SINGAPORE   // Asia/Singapore (UTC+8)
  };

// Per-session override: TZO_DEFAULT falls back to the default session timezone.
enum ENUM_SESSION_TZ_OPT
  {
   TZO_DEFAULT,   // Use default session timezone
   TZO_LAGOS,     // Africa/Lagos (UTC+1)
   TZO_UTC,       // Etc/UTC
   TZO_LONDON,    // Europe/London (GMT/BST, EU-UK rules)
   TZO_NEWYORK,   // America/New_York (EST/EDT, US rules)
   TZO_TOKYO,     // Asia/Tokyo (UTC+9)
   TZO_SINGAPORE  // Asia/Singapore (UTC+8)
  };

//+------------------------------------------------------------------+
//| 1. Timeframe                                                     |
//+------------------------------------------------------------------+
input group "1. Timeframe"
input ENUM_TIMEFRAMES InpSignalTF = PERIOD_CURRENT; // Signal Timeframe (PERIOD_CURRENT = chart)
input bool   InpPineBarLag        = true;           // Replicate TradingView one-bar entry lag

//+------------------------------------------------------------------+
//| 2. Sweep Settings                                                |
//+------------------------------------------------------------------+
input group "2. Sweep Settings"
input double InpSweepBufferPips   = 2.0;            // Stop Buffer (Pips)
input bool   InpAutoPipSize       = true;           // Automatic Pip Size
input double InpManualPipSize     = 0.01;           // Manual Pip Size

//+------------------------------------------------------------------+
//| 3. EMA Trend Filter                                              |
//+------------------------------------------------------------------+
input group "3. EMA Trend Filter"
input bool   InpUseEMA1           = true;           // EMA 1 Enabled
input int    InpEma1Len           = 50;             // EMA 1 Period
input bool   InpUseEMA2           = true;           // EMA 2 Enabled
input int    InpEma2Len           = 100;            // EMA 2 Period
input bool   InpUseEMA3           = true;           // EMA 3 Enabled
input int    InpEma3Len           = 200;            // EMA 3 Period
input bool   InpRequireEMA        = true;           // Use EMA Trend Filter

//+------------------------------------------------------------------+
//| 4. VWAP Filter                                                   |
//+------------------------------------------------------------------+
input group "4. VWAP Filter"
input bool   InpUseVWAP           = false;          // Use VWAP Filter (daily reset, signal TF)

//+------------------------------------------------------------------+
//| 5. Trading Session                                               |
//+------------------------------------------------------------------+
input group "5. Trading Session"
input bool   InpUseSessionFilter  = false;          // Use Session Filter
input bool   InpTradeAsian        = true;           // Trade Asian Session
input bool   InpTradeLondon       = true;           // Trade London Session
input bool   InpTradeNewYork      = true;           // Trade New York Session
input bool   InpTradeCustom       = false;          // Trade Custom Session
input string InpAsianSession      = "0000-0800";    // Asian Session (HHMM-HHMM)
input string InpLondonSession     = "0800-1600";    // London Session (HHMM-HHMM)
input string InpNewYorkSession    = "1300-2100";    // New York Session (HHMM-HHMM)
input int    InpCustomStartHour   = 8;              // Custom Start Hour
input int    InpCustomStartMinute = 0;              // Custom Start Minute
input int    InpCustomEndHour     = 12;             // Custom End Hour
input int    InpCustomEndMinute   = 0;              // Custom End Minute
input ENUM_SESSION_TZ InpSessionTz = TZ_NEWYORK;    // Default Session Timezone
input ENUM_SESSION_TZ_OPT InpAsianTz   = TZO_DEFAULT; // Asian Session Timezone
input ENUM_SESSION_TZ_OPT InpLondonTz  = TZO_DEFAULT; // London Session Timezone
input ENUM_SESSION_TZ_OPT InpNewYorkTz = TZO_DEFAULT; // New York Session Timezone
input ENUM_SESSION_TZ_OPT InpCustomTz  = TZO_DEFAULT; // Custom Session Timezone
input double InpServerGmtOffset   = 0.0;            // Broker Server GMT Offset in hours (Exness: 0)
input bool   InpServerUsesDst     = false;          // Broker Server Shifts With DST (Exness: no)

//+------------------------------------------------------------------+
//| 6. Risk & Trade Management                                       |
//+------------------------------------------------------------------+
input group "6. Risk & Trade Management"
input double InpTp1RR             = 1.0;            // TP1 Risk/Reward
input double InpTp2RR             = 2.0;            // TP2 Risk/Reward
input double InpPartialPercent    = 50.0;           // Partial Close at TP1 (%)
input bool   InpMoveToBE          = true;           // Move Remaining Position to Break-Even

//+------------------------------------------------------------------+
//| 7. Position Sizing & Execution                                   |
//+------------------------------------------------------------------+
input group "7. Position Sizing & Execution"
input bool   InpUseRiskPercent    = false;          // Size From Risk Percent (else fixed lots)
input double InpRiskPercent       = 1.0;            // Risk Per Trade (% of balance)
input double InpFixedLot          = 0.10;           // Fixed Lot Size
input long   InpMagic             = 20260909;       // Magic Number
input ulong  InpSlippagePoints    = 20;             // Max Deviation (points)
input int    InpMaxSpreadPoints   = 0;              // Max Spread (points, 0 = disabled)
input string InpTradeComment      = "SweepEmaVwap"; // Order Comment

//+------------------------------------------------------------------+
//| 8. Display & Alerts                                              |
//+------------------------------------------------------------------+
input group "8. Display & Alerts"
input bool   InpShowTradeZones    = true;           // Show Historical Trade Zones
input bool   InpShowLevels        = true;           // Show Entry/SL/TP Level Lines
input bool   InpShowTradeLabels   = true;           // Show Trade Labels
input color  InpBullColor         = C'0,153,129';   // Bullish/Target Color
input color  InpBearColor         = C'242,54,69';   // Bearish/Stop Color
input color  InpEntryColor        = C'91,156,246';  // Entry/Break-Even Color
input bool   InpEnableAlerts      = true;           // Enable Alerts
input bool   InpEnablePush        = false;          // Send Push Notifications

//+------------------------------------------------------------------+
//| Globals                                                          |
//+------------------------------------------------------------------+
#define OBJ_PREFIX "SEV_"

CTrade          g_trade;

ENUM_TIMEFRAMES g_sigTF          = PERIOD_CURRENT;
int             g_hEma1          = INVALID_HANDLE;
int             g_hEma2          = INVALID_HANDLE;
int             g_hEma3          = INVALID_HANDLE;

double          g_pipSize        = 0.0;
double          g_stopBuffer     = 0.0;
int             g_digits         = 5;
double          g_point          = 0.00001;
int             g_lotDigits      = 2;

datetime        g_lastSignalBar  = 0;
datetime        g_lastChartBar   = 0;

// Pending (one chart bar lag) signal
int             g_pendingDir     = 0;
double          g_pendEntry      = 0.0;
double          g_pendSL         = 0.0;
double          g_pendTP1        = 0.0;
double          g_pendTP2        = 0.0;

// Active trade state
bool            g_tradeActive    = false;
int             g_activeDir      = 0;
double          g_entry          = 0.0;
double          g_sl             = 0.0;
double          g_tp1            = 0.0;
double          g_tp2            = 0.0;
bool            g_tp1Hit         = false;
bool            g_beDone         = false;
double          g_origVolume     = 0.0;
ulong           g_posTicket      = 0;
ulong           g_posId          = 0;

// Visuals
int             g_objSeq         = 0;
string          g_prefix         = "";
bool            g_partialWarned  = false;

//+------------------------------------------------------------------+
//| Small utilities                                                  |
//+------------------------------------------------------------------+
void Notify(const string msg)
  {
   Print(msg);
   if(!InpEnableAlerts)
      return;
   if(MQLInfoInteger(MQL_TESTER) || MQLInfoInteger(MQL_OPTIMIZATION))
      return;
   Alert(msg);
   if(InpEnablePush)
      SendNotification(msg);
  }

double NP(const double price)
  {
   return NormalizeDouble(price, g_digits);
  }

int LotDigitsFromStep(const double step)
  {
   double s = step;
   int d = 0;
   while(s < 1.0 - 1e-12 && d < 8)
     {
      s *= 10.0;
      d++;
     }
   return d;
  }

double NormalizeLots(const double lots)
  {
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0)
      step = 0.01;
   double v = MathFloor(lots / step + 1e-8) * step;
   if(v < minL)
      v = minL;
   if(v > maxL)
      v = maxL;
   return NormalizeDouble(v, g_lotDigits);
  }

//+------------------------------------------------------------------+
//| Pip size (mirrors the Pine automatic/manual pip logic)           |
//+------------------------------------------------------------------+
double ComputePipSize()
  {
   if(!InpAutoPipSize)
      return InpManualPipSize;

   long calcMode = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_CALC_MODE);
   bool isForex  = (calcMode == SYMBOL_CALC_MODE_FOREX ||
                    calcMode == SYMBOL_CALC_MODE_FOREX_NO_LEVERAGE);

   if(isForex)
      return (g_digits == 3 || g_digits == 5) ? g_point * 10.0 : g_point;

   return g_point;
  }

//+------------------------------------------------------------------+
//| Calendar helpers used for the session timezone conversion        |
//+------------------------------------------------------------------+
datetime DateAt(const int year, const int month, const int day)
  {
   MqlDateTime dt;
   dt.year        = year;
   dt.mon         = month;
   dt.day         = day;
   dt.hour        = 0;
   dt.min         = 0;
   dt.sec         = 0;
   dt.day_of_week = 0;
   dt.day_of_year = 0;
   return StructToTime(dt);
  }

int DowOf(const datetime t)
  {
   MqlDateTime dt;
   TimeToStruct(t, dt);
   return dt.day_of_week; // 0 = Sunday
  }

datetime NthDowOfMonth(const int year, const int month, const int dow, const int nth)
  {
   datetime first  = DateAt(year, month, 1);
   int      offset = (dow - DowOf(first) + 7) % 7;
   return first + (datetime)((offset + (nth - 1) * 7) * 86400);
  }

datetime LastDowOfMonth(const int year, const int month, const int dow)
  {
   int nextYear  = (month == 12) ? year + 1 : year;
   int nextMonth = (month == 12) ? 1 : month + 1;
   datetime last = DateAt(nextYear, nextMonth, 1) - 86400;
   int back      = (DowOf(last) - dow + 7) % 7;
   return last - (datetime)(back * 86400);
  }

// US rule: second Sunday of March 02:00 EST -> first Sunday of November 02:00 EDT
bool IsUsDst(const datetime gmt)
  {
   MqlDateTime dt;
   TimeToStruct(gmt, dt);
   datetime start = NthDowOfMonth(dt.year, 3, 0, 2) + 7 * 3600;
   datetime end   = NthDowOfMonth(dt.year, 11, 0, 1) + 6 * 3600;
   return (gmt >= start && gmt < end);
  }

// EU rule: last Sunday of March 01:00 UTC -> last Sunday of October 01:00 UTC
bool IsEuDst(const datetime gmt)
  {
   MqlDateTime dt;
   TimeToStruct(gmt, dt);
   datetime start = LastDowOfMonth(dt.year, 3, 0) + 3600;
   datetime end   = LastDowOfMonth(dt.year, 10, 0) + 3600;
   return (gmt >= start && gmt < end);
  }

int TzOffsetSeconds(const ENUM_SESSION_TZ tz, const datetime gmt)
  {
   switch(tz)
     {
      case TZ_LAGOS:     return 3600;
      case TZ_UTC:       return 0;
      case TZ_LONDON:    return IsEuDst(gmt) ? 3600 : 0;
      case TZ_NEWYORK:   return IsUsDst(gmt) ? -4 * 3600 : -5 * 3600;
      case TZ_TOKYO:     return 9 * 3600;
      case TZ_SINGAPORE: return 8 * 3600;
     }
   return 0;
  }

datetime ServerToGmt(const datetime serverTime)
  {
   double off = InpServerGmtOffset;
   if(InpServerUsesDst && IsUsDst(serverTime))
      off += 1.0;
   return (datetime)((long)serverTime - (long)MathRound(off * 3600.0));
  }

//+------------------------------------------------------------------+
//| Session handling                                                 |
//+------------------------------------------------------------------+
bool ParseSession(const string spec, int &startMin, int &endMin)
  {
   string parts[];
   if(StringSplit(spec, StringGetCharacter("-", 0), parts) != 2)
      return false;

   string a = parts[0];
   string b = parts[1];

   int colon = StringFind(b, ":");   // tolerate an optional ":1234567" day suffix
   if(colon >= 0)
      b = StringSubstr(b, 0, colon);

   StringTrimLeft(a);
   StringTrimRight(a);
   StringTrimLeft(b);
   StringTrimRight(b);

   if(StringLen(a) != 4 || StringLen(b) != 4)
      return false;

   int sh = (int)StringToInteger(StringSubstr(a, 0, 2));
   int sm = (int)StringToInteger(StringSubstr(a, 2, 2));
   int eh = (int)StringToInteger(StringSubstr(b, 0, 2));
   int em = (int)StringToInteger(StringSubstr(b, 2, 2));

   if(sh < 0 || sh > 24 || eh < 0 || eh > 24 || sm < 0 || sm > 59 || em < 0 || em > 59)
      return false;

   startMin = sh * 60 + sm;
   endMin   = eh * 60 + em;
   return true;
  }

ENUM_SESSION_TZ ResolveTz(const ENUM_SESSION_TZ_OPT opt)
  {
   switch(opt)
     {
      case TZO_LAGOS:     return TZ_LAGOS;
      case TZO_UTC:       return TZ_UTC;
      case TZO_LONDON:    return TZ_LONDON;
      case TZO_NEWYORK:   return TZ_NEWYORK;
      case TZO_TOKYO:     return TZ_TOKYO;
      case TZO_SINGAPORE: return TZ_SINGAPORE;
     }
   return InpSessionTz;                                // TZO_DEFAULT
  }

datetime ServerToTz(const datetime serverTime, const ENUM_SESSION_TZ tz)
  {
   datetime gmt = ServerToGmt(serverTime);
   return gmt + (datetime)TzOffsetSeconds(tz, gmt);
  }

int SessionMinuteNow(const datetime serverTime, const ENUM_SESSION_TZ tz)
  {
   MqlDateTime dt;
   TimeToStruct(ServerToTz(serverTime, tz), dt);
   return dt.hour * 60 + dt.min;
  }

bool WindowContains(const int startMin, const int endMin, const int nowMin)
  {
   if(startMin == endMin)
      return true;                                    // full day
   if(startMin < endMin)
      return (nowMin >= startMin && nowMin < endMin);
   return (nowMin >= startMin || nowMin < endMin);     // overnight window
  }

bool SessionActive(const string spec, const datetime serverTime, const ENUM_SESSION_TZ tz)
  {
   int s = 0, e = 0;
   if(!ParseSession(spec, s, e))
      return false;
   return WindowContains(s, e, SessionMinuteNow(serverTime, tz));
  }

bool CustomSessionActive(const datetime serverTime, const ENUM_SESSION_TZ tz)
  {
   int s = InpCustomStartHour * 60 + InpCustomStartMinute;
   int e = InpCustomEndHour * 60 + InpCustomEndMinute;
   return WindowContains(s, e, SessionMinuteNow(serverTime, tz));
  }

bool InTradingSession(const datetime serverTime)
  {
   if(!InpUseSessionFilter)
      return true;

   if(InpTradeAsian && SessionActive(InpAsianSession, serverTime, ResolveTz(InpAsianTz)))
      return true;
   if(InpTradeLondon && SessionActive(InpLondonSession, serverTime, ResolveTz(InpLondonTz)))
      return true;
   if(InpTradeNewYork && SessionActive(InpNewYorkSession, serverTime, ResolveTz(InpNewYorkTz)))
      return true;
   if(InpTradeCustom && CustomSessionActive(serverTime, ResolveTz(InpCustomTz)))
      return true;

   return false;
  }

//+------------------------------------------------------------------+
//| Indicator access                                                 |
//+------------------------------------------------------------------+
bool BufferValue(const int handle, const int shift, double &value)
  {
   double buf[];
   if(CopyBuffer(handle, 0, shift, 1, buf) != 1)
      return false;
   value = buf[0];
   return true;
  }

// Session (daily reset) VWAP on the signal timeframe, value of the last closed bar.
bool SignalVwap(double &value)
  {
   datetime t1 = iTime(_Symbol, g_sigTF, 1);
   if(t1 == 0)
      return false;

   MqlDateTime dt;
   TimeToStruct(t1, dt);
   dt.hour = 0;
   dt.min  = 0;
   dt.sec  = 0;
   datetime dayStart = StructToTime(dt);

   MqlRates rates[];
   int n = CopyRates(_Symbol, g_sigTF, dayStart, t1, rates);
   if(n <= 0)
     {
      if(CopyRates(_Symbol, g_sigTF, 1, 1, rates) != 1)
         return false;
      n = 1;
     }

   double pv = 0.0, vol = 0.0;
   for(int i = 0; i < n; i++)
     {
      if(rates[i].time > t1)
         continue;
      double v = (double)(rates[i].real_volume > 0 ? rates[i].real_volume : rates[i].tick_volume);
      if(v <= 0.0)
         v = 1.0;                                     // Pine volume fallback
      double hlc3 = (rates[i].high + rates[i].low + rates[i].close) / 3.0;
      pv  += hlc3 * v;
      vol += v;
     }

   if(vol <= 0.0)
      return false;

   value = pv / vol;
   return true;
  }

//+------------------------------------------------------------------+
//| Position helpers                                                 |
//+------------------------------------------------------------------+
bool FindPosition(ulong &ticket)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;
      ticket = t;
      return true;
     }
   return false;
  }

bool HasPosition()
  {
   ulong t = 0;
   return FindPosition(t);
  }

double ClosingDealPrice(const ulong positionId)
  {
   if(positionId == 0)
      return 0.0;
   if(!HistorySelectByPosition(positionId))
      return 0.0;

   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0)
         continue;
      long entryType = HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entryType == DEAL_ENTRY_OUT || entryType == DEAL_ENTRY_OUT_BY)
         return HistoryDealGetDouble(deal, DEAL_PRICE);
     }
   return 0.0;
  }

//+------------------------------------------------------------------+
//| Chart objects                                                    |
//+------------------------------------------------------------------+
void MakeRectangle(const string name, const datetime t1, const datetime t2,
                   const double p1, const double p2, const color clr)
  {
   if(!ObjectCreate(0, name, OBJ_RECTANGLE, 0, t1, p1, t2, p2))
      return;
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FILL, true);
   ObjectSetInteger(0, name, OBJPROP_BACK, true);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
  }

void MakeLine(const string name, const datetime t1, const datetime t2,
              const double price, const color clr, const int width,
              const ENUM_LINE_STYLE style)
  {
   if(!ObjectCreate(0, name, OBJ_TREND, 0, t1, price, t2, price))
      return;
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, width);
   ObjectSetInteger(0, name, OBJPROP_STYLE, style);
   ObjectSetInteger(0, name, OBJPROP_RAY_RIGHT, false);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
  }

void MakeText(const string name, const datetime t, const double price,
              const string text, const color clr, const bool above)
  {
   if(!ObjectCreate(0, name, OBJ_TEXT, 0, t, price))
      return;
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 8);
   ObjectSetInteger(0, name, OBJPROP_ANCHOR, above ? ANCHOR_LOWER : ANCHOR_UPPER);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
  }

void SetRightEdge(const string name, const datetime t)
  {
   if(ObjectFind(0, name) < 0)
      return;
   ObjectSetInteger(0, name, OBJPROP_TIME, 1, (long)t);
  }

void CreateTradeVisuals(const int dir)
  {
   datetime t1 = iTime(_Symbol, _Period, 0);
   g_objSeq++;
   g_prefix = OBJ_PREFIX + IntegerToString((long)t1) + "_" + IntegerToString(g_objSeq) + "_";

   datetime t2 = t1 + PeriodSeconds(_Period);

   if(InpShowTradeZones)
     {
      MakeRectangle(g_prefix + "TARGET", t1, t2, g_entry, g_tp2, InpBullColor);
      MakeRectangle(g_prefix + "STOP",   t1, t2, g_entry, g_sl,  InpBearColor);
     }

   if(InpShowLevels)
     {
      MakeLine(g_prefix + "ENTRY", t1, t2, g_entry, InpEntryColor, 1, STYLE_SOLID);
      MakeLine(g_prefix + "SL",    t1, t2, g_sl,    InpBearColor,  1, STYLE_SOLID);
      MakeLine(g_prefix + "TP1",   t1, t2, g_tp1,   InpBullColor,  1, STYLE_DASH);
      MakeLine(g_prefix + "TP2",   t1, t2, g_tp2,   InpBullColor,  1, STYLE_SOLID);
     }

   if(InpShowTradeLabels)
      MakeText(g_prefix + "OPEN", t1, g_entry, (dir > 0 ? "Buy" : "Sell"),
               (dir > 0 ? InpBullColor : InpBearColor), dir < 0);
  }

void ExtendTradeVisuals()
  {
   if(g_prefix == "")
      return;
   datetime t = iTime(_Symbol, _Period, 0) + PeriodSeconds(_Period);
   SetRightEdge(g_prefix + "TARGET", t);
   SetRightEdge(g_prefix + "STOP",   t);
   SetRightEdge(g_prefix + "ENTRY",  t);
   SetRightEdge(g_prefix + "SL",     t);
   SetRightEdge(g_prefix + "TP1",    t);
   SetRightEdge(g_prefix + "TP2",    t);
  }

void FinalizeTradeVisuals()
  {
   if(g_prefix == "")
      return;
   datetime t = iTime(_Symbol, _Period, 0);
   SetRightEdge(g_prefix + "TARGET", t);
   SetRightEdge(g_prefix + "STOP",   t);
   SetRightEdge(g_prefix + "ENTRY",  t);
   SetRightEdge(g_prefix + "SL",     t);
   SetRightEdge(g_prefix + "TP1",    t);
   SetRightEdge(g_prefix + "TP2",    t);
   if(g_beDone && ObjectFind(0, g_prefix + "SL") >= 0)
     {
      ObjectSetDouble(0, g_prefix + "SL", OBJPROP_PRICE, 0, g_entry);
      ObjectSetDouble(0, g_prefix + "SL", OBJPROP_PRICE, 1, g_entry);
      ObjectSetInteger(0, g_prefix + "SL", OBJPROP_COLOR, InpEntryColor);
     }
  }

//+------------------------------------------------------------------+
//| Position sizing                                                  |
//+------------------------------------------------------------------+
double CalcLots(const double riskDistance)
  {
   if(!InpUseRiskPercent)
      return NormalizeLots(InpFixedLot);

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(riskDistance <= 0.0 || tickValue <= 0.0 || tickSize <= 0.0)
      return NormalizeLots(InpFixedLot);

   double riskMoney  = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0;
   double lossPerLot = (riskDistance / tickSize) * tickValue;
   if(lossPerLot <= 0.0)
      return NormalizeLots(InpFixedLot);

   return NormalizeLots(riskMoney / lossPerLot);
  }

//+------------------------------------------------------------------+
//| Trade opening                                                    |
//+------------------------------------------------------------------+
bool OpenTrade(const int dir, const double entry, const double sl,
               const double tp1, const double tp2)
  {
   if(!MQLInfoInteger(MQL_TESTER))
     {
      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
        {
         Print("Trading not allowed; signal skipped.");
         return false;
        }
     }

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   if(InpMaxSpreadPoints > 0)
     {
      double spreadPoints = (tick.ask - tick.bid) / g_point;
      if(spreadPoints > (double)InpMaxSpreadPoints)
        {
         PrintFormat("Spread %.1f points above the %d point limit; signal skipped.",
                     spreadPoints, InpMaxSpreadPoints);
         return false;
        }
     }

   double stopsLevel = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_point;
   double refPrice   = (dir > 0) ? tick.ask : tick.bid;
   if(stopsLevel > 0.0)
     {
      if(MathAbs(refPrice - sl) < stopsLevel || MathAbs(tp2 - refPrice) < stopsLevel)
        {
         Print("Stop or target closer than the broker stops level; signal skipped.");
         return false;
        }
     }

   double lots = CalcLots(MathAbs(entry - sl));
   if(lots <= 0.0)
      return false;

   bool ok = (dir > 0)
             ? g_trade.Buy(lots, _Symbol, 0.0, NP(sl), NP(tp2), InpTradeComment)
             : g_trade.Sell(lots, _Symbol, 0.0, NP(sl), NP(tp2), InpTradeComment);

   if(!ok)
     {
      PrintFormat("Order failed. retcode=%d %s", g_trade.ResultRetcode(),
                  g_trade.ResultRetcodeDescription());
      return false;
     }

   ulong ticket = 0;
   if(!FindPosition(ticket))
     {
      Print("Order sent but no position found for this symbol and magic number.");
      return false;
     }

   g_posTicket   = ticket;
   g_posId       = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   g_origVolume  = PositionGetDouble(POSITION_VOLUME);
   g_tradeActive = true;
   g_activeDir   = dir;
   g_entry       = entry;
   g_sl          = sl;
   g_tp1         = tp1;
   g_tp2         = tp2;
   g_tp1Hit      = false;
   g_beDone      = false;

   CreateTradeVisuals(dir);

   Notify(StringFormat("%s %s %.2f lots | entry %s SL %s TP1 %s TP2 %s",
                       (dir > 0 ? "BUY" : "SELL"), _Symbol, g_origVolume,
                       DoubleToString(entry, g_digits), DoubleToString(sl, g_digits),
                       DoubleToString(tp1, g_digits), DoubleToString(tp2, g_digits)));
   return true;
  }

//+------------------------------------------------------------------+
//| Trade management: TP1 partial close and break-even               |
//+------------------------------------------------------------------+
void ManagePosition()
  {
   if(!g_tradeActive)
      return;
   if(!PositionSelectByTicket(g_posTicket))
      return;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return;

   bool reachedTP1 = false;
   if(!g_tp1Hit)
     {
      if(g_activeDir > 0 && tick.bid >= g_tp1)
         reachedTP1 = true;
      if(g_activeDir < 0 && tick.ask <= g_tp1)
         reachedTP1 = true;
     }

   if(reachedTP1)
     {
      double curVol  = PositionGetDouble(POSITION_VOLUME);
      double partVol = NormalizeLots(g_origVolume * InpPartialPercent / 100.0);
      double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
      bool   handled = false;

      if(partVol > curVol)
         partVol = NormalizeLots(curVol);

      if(partVol >= minLot - 1e-8 && (curVol - partVol) >= minLot - 1e-8)
        {
         if(g_trade.PositionClosePartial(g_posTicket, partVol))
           {
            handled = true;
            Notify(StringFormat("TP1 reached. Closed %.2f lots at %s.",
                                partVol, DoubleToString(g_tp1, g_digits)));
           }
         else
            PrintFormat("Partial close failed, retrying on the next tick. retcode=%d %s",
                        g_trade.ResultRetcode(), g_trade.ResultRetcodeDescription());
        }
      else
        {
         handled = true;                              // volume cannot be split
         if(!g_partialWarned)
           {
            g_partialWarned = true;
            PrintFormat("Partial close skipped: minimum lot (%.2f) cannot split %.2f lots.",
                        minLot, g_origVolume);
           }
        }

      if(handled)
        {
         g_tp1Hit = true;
         if(InpShowTradeLabels)
            MakeText(g_prefix + "TP1LBL", iTime(_Symbol, _Period, 0), g_tp1, "TP1",
                     InpBullColor, g_activeDir < 0);
        }
     }

   if(g_tp1Hit && InpMoveToBE && !g_beDone && PositionSelectByTicket(g_posTicket))
     {
      double curSL = PositionGetDouble(POSITION_SL);
      double target = NP(g_entry);
      bool needsMove = (g_activeDir > 0) ? (curSL < target - g_point / 2.0)
                                         : (curSL > target + g_point / 2.0 || curSL == 0.0);
      if(needsMove)
        {
         if(g_trade.PositionModify(g_posTicket, target, NP(g_tp2)))
           {
            g_beDone = true;
            Notify("Break-even activated: stop moved to entry.");
           }
        }
      else
         g_beDone = true;
     }
  }

//+------------------------------------------------------------------+
//| Trade closure detection and classification                       |
//+------------------------------------------------------------------+
void HandleTradeClosed()
  {
   double price = ClosingDealPrice(g_posId);
   if(price <= 0.0)
     {
      MqlTick tick;
      if(SymbolInfoTick(_Symbol, tick))
         price = (g_activeDir > 0) ? tick.bid : tick.ask;
     }

   double dTarget = MathAbs(price - g_tp2);
   double dStop   = MathAbs(price - g_sl);
   double dBE     = (g_tp1Hit && InpMoveToBE) ? MathAbs(price - g_entry) : DBL_MAX;

   string outcome = "SL";
   color  clr     = InpBearColor;
   double lvl     = g_sl;

   if(dTarget <= dStop && dTarget <= dBE)
     {
      outcome = "TP";
      clr     = InpBullColor;
      lvl     = g_tp2;
     }
   else if(dBE <= dStop && dBE <= dTarget)
     {
      outcome = "BE";
      clr     = InpEntryColor;
      lvl     = g_entry;
     }

   FinalizeTradeVisuals();

   if(InpShowTradeLabels)
      MakeText(g_prefix + "CLOSE", iTime(_Symbol, _Period, 0), lvl,
               (g_activeDir > 0 ? "Long " : "Short ") + outcome, clr, g_activeDir < 0);

   Notify(StringFormat("%s position closed at %s (%s).",
                       (g_activeDir > 0 ? "Long" : "Short"),
                       DoubleToString(price, g_digits), outcome));

   g_tradeActive   = false;
   g_activeDir     = 0;
   g_entry         = 0.0;
   g_sl            = 0.0;
   g_tp1           = 0.0;
   g_tp2           = 0.0;
   g_tp1Hit        = false;
   g_beDone        = false;
   g_origVolume    = 0.0;
   g_posTicket     = 0;
   g_posId         = 0;
   g_prefix        = "";
   g_partialWarned = false;
  }

void SyncState()
  {
   ulong ticket = 0;
   bool  has    = FindPosition(ticket);

   if(g_tradeActive && !has)
     {
      HandleTradeClosed();
      return;
     }

   if(has)
      g_posTicket = ticket;
  }

//+------------------------------------------------------------------+
//| Signal evaluation on the last closed signal-timeframe candle     |
//+------------------------------------------------------------------+
void EvaluateSignal()
  {
   MqlRates r[];
   if(CopyRates(_Symbol, g_sigTF, 1, 2, r) != 2)
      return;

   datetime signalBarTime = r[1].time;
   if(signalBarTime == g_lastSignalBar)
      return;                                  // no newly closed signal candle
   g_lastSignalBar = signalBarTime;

   if(g_tradeActive || g_pendingDir != 0 || HasPosition())
      return;                                  // pyramiding 0: one trade at a time

   // r[0] = previous candle, r[1] = sweep (current) candle
   double pOpen = r[0].open, pHigh = r[0].high, pLow = r[0].low, pClose = r[0].close;
   double cOpen = r[1].open, cHigh = r[1].high, cLow = r[1].low, cClose = r[1].close;

   bool previousBearish = (pClose < pOpen);
   bool previousBullish = (pClose > pOpen);
   bool currentBullish  = (cClose > cOpen);
   bool currentBearish  = (cClose < cOpen);

   double prevBodyHigh = MathMax(pOpen, pClose);
   double prevBodyLow  = MathMin(pOpen, pClose);

   bool buySweep  = previousBearish && (cLow < pLow)   && currentBullish && (cClose > prevBodyHigh);
   bool sellSweep = previousBullish && (cHigh > pHigh) && currentBearish && (cClose < prevBodyLow);

   if(!buySweep && !sellSweep)
      return;

   // --- EMA trend filter -------------------------------------------------
   int enabledEMAcount = 0;
   if(InpUseEMA1) enabledEMAcount++;
   if(InpUseEMA2) enabledEMAcount++;
   if(InpUseEMA3) enabledEMAcount++;

   bool emaBullTrend = true;
   bool emaBearTrend = true;

   if(InpRequireEMA)
     {
      double e1 = 0.0, e2 = 0.0, e3 = 0.0;
      if(InpUseEMA1 && !BufferValue(g_hEma1, 1, e1)) return;
      if(InpUseEMA2 && !BufferValue(g_hEma2, 1, e2)) return;
      if(InpUseEMA3 && !BufferValue(g_hEma3, 1, e3)) return;

      if(InpUseEMA1)
        {
         emaBullTrend = emaBullTrend && (cClose > e1);
         emaBearTrend = emaBearTrend && (cClose < e1);
        }
      if(InpUseEMA2)
        {
         emaBullTrend = emaBullTrend && (cClose > e2);
         emaBearTrend = emaBearTrend && (cClose < e2);
        }
      if(InpUseEMA3)
        {
         emaBullTrend = emaBullTrend && (cClose > e3);
         emaBearTrend = emaBearTrend && (cClose < e3);
        }

      if(InpUseEMA1 && InpUseEMA2)
        {
         emaBullTrend = emaBullTrend && (e1 > e2);
         emaBearTrend = emaBearTrend && (e1 < e2);
        }
      if(InpUseEMA1 && InpUseEMA3)
        {
         emaBullTrend = emaBullTrend && (e1 > e3);
         emaBearTrend = emaBearTrend && (e1 < e3);
        }
      if(InpUseEMA2 && InpUseEMA3)
        {
         emaBullTrend = emaBullTrend && (e2 > e3);
         emaBearTrend = emaBearTrend && (e2 < e3);
        }
     }

   bool emaTrendBullOK = !InpRequireEMA || (enabledEMAcount > 0 && emaBullTrend);
   bool emaTrendBearOK = !InpRequireEMA || (enabledEMAcount > 0 && emaBearTrend);

   // --- VWAP filter ------------------------------------------------------
   bool vwapBullOK = true;
   bool vwapBearOK = true;
   if(InpUseVWAP)
     {
      double vwap = 0.0;
      if(!SignalVwap(vwap))
         return;
      vwapBullOK = (cClose > vwap);
      vwapBearOK = (cClose < vwap);
     }

   // --- Session filter ---------------------------------------------------
   if(!InTradingSession(TimeCurrent()))
      return;

   bool buySignal  = buySweep  && emaTrendBullOK && vwapBullOK;
   bool sellSignal = sellSweep && emaTrendBearOK && vwapBearOK;

   if(!buySignal && !sellSignal)
      return;

   int    dir        = buySignal ? 1 : -1;
   double entryPrice = cClose;
   double stopPrice  = buySignal ? (cLow - g_stopBuffer) : (cHigh + g_stopBuffer);
   double risk       = buySignal ? (entryPrice - stopPrice) : (stopPrice - entryPrice);

   if(risk <= 0.0)
      return;

   double tp1 = buySignal ? entryPrice + risk * InpTp1RR : entryPrice - risk * InpTp1RR;
   double tp2 = buySignal ? entryPrice + risk * InpTp2RR : entryPrice - risk * InpTp2RR;

   if(InpPineBarLag)
     {
      g_pendingDir = dir;
      g_pendEntry  = entryPrice;
      g_pendSL     = stopPrice;
      g_pendTP1    = tp1;
      g_pendTP2    = tp2;
      return;
     }

   OpenTrade(dir, entryPrice, stopPrice, tp1, tp2);
  }

//+------------------------------------------------------------------+
//| Adopt an existing position after a restart or recompile          |
//+------------------------------------------------------------------+
void RestoreState()
  {
   ulong ticket = 0;
   if(!FindPosition(ticket))
      return;
   if(!PositionSelectByTicket(ticket))
      return;

   g_objSeq++;
   g_prefix      = OBJ_PREFIX + IntegerToString((long)TimeCurrent()) + "_" +
                   IntegerToString(g_objSeq) + "_";
   g_posTicket   = ticket;
   g_posId       = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   g_entry       = PositionGetDouble(POSITION_PRICE_OPEN);
   g_sl          = PositionGetDouble(POSITION_SL);
   g_tp2         = PositionGetDouble(POSITION_TP);
   g_origVolume  = PositionGetDouble(POSITION_VOLUME);
   g_activeDir   = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 1 : -1;
   g_tradeActive = true;

   double risk = MathAbs(g_entry - g_sl);
   if(risk <= 0.0 && InpTp2RR > 0.0)
      risk = MathAbs(g_tp2 - g_entry) / InpTp2RR;

   g_tp1 = (g_activeDir > 0) ? g_entry + risk * InpTp1RR : g_entry - risk * InpTp1RR;

   // Stop already at or beyond entry means TP1 and break-even were handled.
   if(g_activeDir > 0 && g_sl >= g_entry - g_point / 2.0)
     {
      g_tp1Hit = true;
      g_beDone = true;
     }
   if(g_activeDir < 0 && g_sl != 0.0 && g_sl <= g_entry + g_point / 2.0)
     {
      g_tp1Hit = true;
      g_beDone = true;
     }

   PrintFormat("Existing position adopted. dir=%d entry=%s SL=%s TP2=%s",
               g_activeDir, DoubleToString(g_entry, g_digits),
               DoubleToString(g_sl, g_digits), DoubleToString(g_tp2, g_digits));
  }

//+------------------------------------------------------------------+
//| Timezone diagnostics                                             |
//+------------------------------------------------------------------+
string TzName(const ENUM_SESSION_TZ tz)
  {
   switch(tz)
     {
      case TZ_LAGOS:     return "Africa/Lagos";
      case TZ_UTC:       return "Etc/UTC";
      case TZ_LONDON:    return "Europe/London";
      case TZ_NEWYORK:   return "America/New_York";
      case TZ_TOKYO:     return "Asia/Tokyo";
      case TZ_SINGAPORE: return "Asia/Singapore";
     }
   return "Unknown";
  }

void LogTimezones()
  {
   datetime server = TimeCurrent();
   datetime gmt    = ServerToGmt(server);

   PrintFormat("Clocks | server %s (configured GMT%+.1f%s) | GMT %s | New York %s %s | London %s %s",
               TimeToString(server, TIME_DATE | TIME_MINUTES),
               InpServerGmtOffset, (InpServerUsesDst ? ", DST shift on" : ""),
               TimeToString(gmt, TIME_DATE | TIME_MINUTES),
               TimeToString(ServerToTz(server, TZ_NEWYORK), TIME_DATE | TIME_MINUTES),
               (IsUsDst(gmt) ? "EDT" : "EST"),
               TimeToString(ServerToTz(server, TZ_LONDON), TIME_DATE | TIME_MINUTES),
               (IsEuDst(gmt) ? "BST" : "GMT"));

   PrintFormat("Session zones | default %s | Asian %s | London %s | New York %s | Custom %s",
               TzName(InpSessionTz), TzName(ResolveTz(InpAsianTz)), TzName(ResolveTz(InpLondonTz)),
               TzName(ResolveTz(InpNewYorkTz)), TzName(ResolveTz(InpCustomTz)));

   if(!MQLInfoInteger(MQL_TESTER))
     {
      double configured = InpServerGmtOffset + ((InpServerUsesDst && IsUsDst(server)) ? 1.0 : 0.0);
      double detected   = (double)((long)server - (long)TimeGMT()) / 3600.0;
      if(MathAbs(detected - configured) > 0.75)
         PrintFormat("Warning: this server looks like GMT%+.1f but the offset input resolves to GMT%+.1f. "
                     "Session windows would be shifted by %.1f hours.",
                     detected, configured, detected - configured);
     }
  }

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   g_sigTF = (InpSignalTF == PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)Period() : InpSignalTF;

   g_digits    = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   g_point     = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   g_lotDigits = LotDigitsFromStep(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP));

   if(g_point <= 0.0)
     {
      Print("Invalid symbol point size.");
      return INIT_FAILED;
     }

   if(InpTp1RR <= 0.0 || InpTp2RR <= 0.0)
     {
      Print("TP1 and TP2 risk/reward must both be greater than zero.");
      return INIT_PARAMETERS_INCORRECT;
     }

   if(InpPartialPercent < 1.0 || InpPartialPercent > 99.0)
     {
      Print("Partial close percent must be between 1 and 99.");
      return INIT_PARAMETERS_INCORRECT;
     }

   if(InpEma1Len < 1 || InpEma2Len < 1 || InpEma3Len < 1)
     {
      Print("EMA periods must be greater than zero.");
      return INIT_PARAMETERS_INCORRECT;
     }

   int s = 0, e = 0;
   if(InpUseSessionFilter)
     {
      if(InpTradeAsian && !ParseSession(InpAsianSession, s, e))
         Print("Asian session string is invalid; that session will never be active.");
      if(InpTradeLondon && !ParseSession(InpLondonSession, s, e))
         Print("London session string is invalid; that session will never be active.");
      if(InpTradeNewYork && !ParseSession(InpNewYorkSession, s, e))
         Print("New York session string is invalid; that session will never be active.");
     }

   g_pipSize    = ComputePipSize();
   g_stopBuffer = InpSweepBufferPips * g_pipSize;

   g_hEma1 = iMA(_Symbol, g_sigTF, InpEma1Len, 0, MODE_EMA, PRICE_CLOSE);
   g_hEma2 = iMA(_Symbol, g_sigTF, InpEma2Len, 0, MODE_EMA, PRICE_CLOSE);
   g_hEma3 = iMA(_Symbol, g_sigTF, InpEma3Len, 0, MODE_EMA, PRICE_CLOSE);

   if(g_hEma1 == INVALID_HANDLE || g_hEma2 == INVALID_HANDLE || g_hEma3 == INVALID_HANDLE)
     {
      Print("Failed to create the EMA indicator handles.");
      return INIT_FAILED;
     }

   g_trade.SetExpertMagicNumber((ulong)InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   g_trade.SetAsyncMode(false);

   long fillingModes = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fillingModes & SYMBOL_FILLING_FOK) != 0)
      g_trade.SetTypeFilling(ORDER_FILLING_FOK);
   else if((fillingModes & SYMBOL_FILLING_IOC) != 0)
      g_trade.SetTypeFilling(ORDER_FILLING_IOC);
   else
      g_trade.SetTypeFilling(ORDER_FILLING_RETURN);

   g_lastSignalBar = iTime(_Symbol, g_sigTF, 1);
   g_lastChartBar  = iTime(_Symbol, _Period, 0);

   RestoreState();

   if(!MQLInfoInteger(MQL_OPTIMIZATION))
      LogTimezones();

   PrintFormat("Sweep EMA VWAP started. signalTF=%s pip=%s buffer=%s barLag=%s",
               EnumToString(g_sigTF), DoubleToString(g_pipSize, g_digits),
               DoubleToString(g_stopBuffer, g_digits), (InpPineBarLag ? "on" : "off"));
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   if(g_hEma1 != INVALID_HANDLE) IndicatorRelease(g_hEma1);
   if(g_hEma2 != INVALID_HANDLE) IndicatorRelease(g_hEma2);
   if(g_hEma3 != INVALID_HANDLE) IndicatorRelease(g_hEma3);

   if(reason == REASON_REMOVE)
      ObjectsDeleteAll(0, OBJ_PREFIX);
  }

//+------------------------------------------------------------------+
//| Main tick handler                                                |
//+------------------------------------------------------------------+
void OnTick()
  {
   SyncState();
   ManagePosition();

   datetime chartBar = iTime(_Symbol, _Period, 0);
   if(chartBar == g_lastChartBar)
      return;
   g_lastChartBar = chartBar;

   ExtendTradeVisuals();

   // A signal detected on the previous chart bar fires here, which reproduces
   // the one-bar confirmation lag of the Pine strategy.
   if(g_pendingDir != 0)
     {
      int dir = g_pendingDir;
      g_pendingDir = 0;
      if(!g_tradeActive && !HasPosition())
         OpenTrade(dir, g_pendEntry, g_pendSL, g_pendTP1, g_pendTP2);
     }

   EvaluateSignal();
  }
//+------------------------------------------------------------------+
