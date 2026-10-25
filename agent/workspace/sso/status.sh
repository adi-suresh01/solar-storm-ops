#!/bin/sh
# Space weather now, risk level and the open plan, as plain text.
. "$(dirname "$0")/lib.sh"
S=$(get /state) || { echo "$S"; exit 1; }
R=$(get /risk) || { echo "$R"; exit 1; }
echo "$S" | jq -r '
  "Mode: \(.mode). \(.note)",
  "Time (UTC): \(.sim_time)",
  "Kp now: \(.kp_now)",
  "Max Kp forecast, next 3 days: \([.kp_forecast[].kp] | max // "n/a")",
  "X-ray: \(.xray.class). NOAA scales: R \(.scales.R), S \(.scales.S), G \(.scales.G). Solar wind: \(.solar_wind_kms // "n/a") km/s",
  "Risk level: \(.alert.level). \(.alert.summary)"'
echo "$R" | jq -r '
  "Satellites per band: critical \(.bands.critical), high \(.bands.high), watch \(.bands.watch), fine \(.bands.fine)",
  (.groups[] | "Group: \(.name): \(.count) sats, lowest \(.min_alt_km) km, band \(.band)"),
  (if .recommendation then
     "Open plan \(.recommendation.id) (\(.recommendation.status)): \(.recommendation.summary)",
     "Plan actions: \(.recommendation.actions | join("; "))",
     "Act by: \(.recommendation.deadline)"
   else "Open plan: none" end)'
