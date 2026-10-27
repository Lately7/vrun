# PyLive Inspector benchmark results

Generated: `2026-10-27T16:41:23.940924+00:00`

## Environment

| Field | Value |
|---|---|
| OS | Windows-11-10.0.26200-SP0 |
| CPU | Intel64 Family 6 Model 154 Stepping 3, GenuineIntel |
| Python | 3.15.1 |
| pandas | 3.1.0 |
| NumPy | 2.5.4 |
| psutil | available |

## Cold kernel startup

| Runs | Min ms | Median ms | Max ms | Ready bytes (median) |
|---:|---:|---:|---:|---:|
| 3 | 319.686 | 332.596 | 342.958 | 543 |

## DataFrame creation and peak RSS

| Rows | Worker creation ms | Round-trip ms | Response bytes | Peak RSS MiB |
|---:|---:|---:|---:|---:|
| 1,000 | 1579.430 | 1581.258 | 138 | 82.42 |
| 100,000 | 1540.920 | 1542.514 | 138 | 98.27 |

## 1,000 rows — warm inspection (5 runs)

| Request | Min ms | Median ms | Max ms | Response bytes min/median/max |
|---|---:|---:|---:|---:|
| `variables.list` | 0.836 | 0.977 | 1.463 | 320 / 320 / 320 |
| `dataframe.metadata` | 1.026 | 1.107 | 1.121 | 782 / 783 / 783 |
| `dataframe.page.first` | 1.377 | 1.593 | 2.015 | 7,134 / 7,134 / 7,134 |
| `dataframe.page.middle` | 1.216 | 1.336 | 1.477 | 7,211 / 7,211 / 7,211 |
| `dataframe.page.last` | 1.227 | 1.462 | 2.075 | 7,213 / 7,213 / 7,213 |
| `dataframe.page.sort_first` | 1.954 | 2.232 | 2.454 | 7,162 / 7,162 / 7,162 |
| `dataframe.page.sort_cached` | 1.539 | 1.695 | 1.988 | 7,162 / 7,162 / 7,162 |
| `dataframe.page.filter` | 2.064 | 2.166 | 2.589 | 6,944 / 6,944 / 6,945 |
| `dataframe.summary` | 5.073 | 5.165 | 6.456 | 1,186 / 1,186 / 1,186 |

### Interrupt

Latency is measured from sending `interrupt` until the infinite-loop `execute` response arrives.

| Min ms | Median ms | Max ms | Execute response bytes (median) | Interrupt response bytes (median) |
|---:|---:|---:|---:|---:|
| 15.633 | 15.883 | 16.198 | 284 | 86 |

## 100,000 rows — warm inspection (5 runs)

| Request | Min ms | Median ms | Max ms | Response bytes min/median/max |
|---|---:|---:|---:|---:|
| `variables.list` | 0.944 | 1.037 | 1.296 | 324 / 324 / 324 |
| `dataframe.metadata` | 0.930 | 1.083 | 1.216 | 786 / 787 / 787 |
| `dataframe.page.first` | 1.355 | 1.408 | 1.752 | 7,150 / 7,150 / 7,150 |
| `dataframe.page.middle` | 1.315 | 1.644 | 1.782 | 7,491 / 7,491 / 7,491 |
| `dataframe.page.last` | 1.321 | 1.464 | 1.724 | 7,494 / 7,494 / 7,494 |
| `dataframe.page.sort_first` | 16.080 | 17.084 | 17.966 | 7,433 / 7,433 / 7,433 |
| `dataframe.page.sort_cached` | 1.744 | 2.097 | 2.383 | 7,433 / 7,433 / 7,433 |
| `dataframe.page.filter` | 8.306 | 8.724 | 9.478 | 6,970 / 6,970 / 6,971 |
| `dataframe.summary` | 27.155 | 28.166 | 28.445 | 1,200 / 1,200 / 1,200 |

### Interrupt

Latency is measured from sending `interrupt` until the infinite-loop `execute` response arrives.

| Min ms | Median ms | Max ms | Execute response bytes (median) | Interrupt response bytes (median) |
|---:|---:|---:|---:|---:|
| 15.140 | 15.358 | 15.783 | 284 | 86 |

Response sizes are exact UTF-8 NDJSON line lengths, including the trailing newline. Uncached sort and filter samples clear the page cache with a no-op execute before each run.
