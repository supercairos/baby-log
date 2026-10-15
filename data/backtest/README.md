# Other children's logs, for `scripts/backtest-predict.mts --file`

Public app exports converted with `scripts/logs-from-export.mts`. **Not committed** (the
folder is gitignored): the licences don't all allow redistribution. Re-download and convert
from the sources below if the files are missing.

| file | source | app | child | licence | run with |
|---|---|---|---|---|---|
| zyw.json | github.com/jiuguangw/Agenoria `data/zyw` | Glow Baby | birth→18 mo, feeds | CC BY-NC-SA 4.0 | `TZ=America/New_York` |
| zlw.json | github.com/jiuguangw/Agenoria `data/zlw` | Glow Baby | birth→12 mo, feeds, diapers | CC BY-NC-SA 4.0 | `TZ=America/New_York` |
| huck.json | github.com/archiewood/baby-tracker `sources/huckleberry/events.csv` | Huckleberry | birth→11 mo, feeds (patchy) | none stated | `TZ=Europe/London` |
| eva.json | github.com/utsengar/eva `eva.csv` | Baby Connect | birth→12 mo, feeds | CC0 | `TZ=America/Los_Angeles` |
| ember.json | github.com/nikicrow/dbt-baby-data `baby_data/seeds` | Baby Tracker | birth→11 mo, feeds, diapers | none stated | `TZ=Australia/Sydney` |
| imogen.json | github.com/nikicrow/dbt-baby-data `baby_data/seeds` | Baby Tracker | birth→5½ mo, sleep only | none stated | `TZ=Australia/Sydney` |

Birth dates used: zyw 2018-11-21, zlw 2022-02-21, huck 2024-04-19, eva 2019-12-20,
ember 2023-09-03, imogen 2026-03-15 (the first logged day where the export doesn't say).

    TZ=America/New_York npx tsx scripts/backtest-predict.mts --file data/backtest/zyw.json --by-age
