# PyLive Inspector benchmark results

Generated: `2026-10-27T17:06:55.868748+00:00`

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
| 3 | 347.414 | 359.764 | 359.819 | 543 |

## DataFrame creation and peak RSS

| Rows | Worker creation ms | Round-trip ms | Response bytes | Peak RSS MiB |
|---:|---:|---:|---:|---:|
| 1,000 | 1442.370 | 1443.935 | 138 | 82.38 |
| 100,000 | 1395.270 | 1397.046 | 138 | 96.66 |
| 500,000 | 1665.110 | 1667.078 | 138 | 177.60 |
| 1,000,000 | 1728.530 | 1730.504 | 138 | 274.14 |

## 1,000 rows — warm inspection (5 runs)

| Request | Min ms | Median ms | Max ms | Response bytes min/median/max |
|---|---:|---:|---:|---:|
| `variables.list` | 0.926 | 1.006 | 1.336 | 320 / 320 / 320 |
| `dataframe.metadata` | 0.926 | 1.171 | 1.648 | 782 / 783 / 783 |
| `dataframe.page.first` | 1.401 | 1.596 | 2.012 | 7,134 / 7,134 / 7,134 |
| `dataframe.page.middle` | 1.338 | 1.411 | 1.629 | 7,211 / 7,211 / 7,211 |
| `dataframe.page.last` | 1.361 | 1.410 | 1.570 | 7,213 / 7,213 / 7,213 |
| `dataframe.page.sort_first` | 1.850 | 1.923 | 2.760 | 7,162 / 7,162 / 7,162 |
| `dataframe.page.sort_cached` | 1.653 | 1.873 | 2.220 | 7,162 / 7,162 / 7,162 |
| `dataframe.page.filter` | 2.090 | 2.304 | 2.843 | 6,944 / 6,944 / 6,945 |
| `dataframe.summary` | 5.063 | 5.173 | 6.148 | 1,186 / 1,186 / 1,186 |

### Interrupt

Latency is measured from sending `interrupt` until the infinite-loop `execute` response arrives.

| Min ms | Median ms | Max ms | Execute response bytes (median) | Interrupt response bytes (median) |
|---:|---:|---:|---:|---:|
| 15.313 | 15.981 | 16.789 | 284 | 86 |

## 100,000 rows — warm inspection (5 runs)

| Request | Min ms | Median ms | Max ms | Response bytes min/median/max |
|---|---:|---:|---:|---:|
| `variables.list` | 1.014 | 1.122 | 1.155 | 324 / 324 / 324 |
| `dataframe.metadata` | 1.093 | 1.165 | 1.320 | 786 / 787 / 787 |
| `dataframe.page.first` | 1.403 | 1.462 | 1.801 | 7,150 / 7,150 / 7,150 |
| `dataframe.page.middle` | 1.351 | 1.492 | 1.701 | 7,491 / 7,491 / 7,491 |
| `dataframe.page.last` | 1.242 | 1.398 | 1.474 | 7,494 / 7,494 / 7,494 |
| `dataframe.page.sort_first` | 16.689 | 17.348 | 17.782 | 7,433 / 7,433 / 7,433 |
| `dataframe.page.sort_cached` | 1.828 | 1.965 | 2.175 | 7,433 / 7,433 / 7,433 |
| `dataframe.page.filter` | 8.581 | 8.810 | 9.884 | 6,970 / 6,970 / 6,971 |
| `dataframe.summary` | 27.089 | 27.913 | 29.356 | 1,200 / 1,200 / 1,200 |

### Interrupt

Latency is measured from sending `interrupt` until the infinite-loop `execute` response arrives.

| Min ms | Median ms | Max ms | Execute response bytes (median) | Interrupt response bytes (median) |
|---:|---:|---:|---:|---:|
| 15.388 | 15.653 | 15.858 | 284 | 86 |

## 500,000 rows — warm inspection (5 runs)

| Request | Min ms | Median ms | Max ms | Response bytes min/median/max |
|---|---:|---:|---:|---:|
| `variables.list` | 0.957 | 1.033 | 1.635 | 325 / 325 / 325 |
| `dataframe.metadata` | 1.150 | 2.263 | 2.547 | 787 / 788 / 788 |
| `dataframe.page.first` | 1.286 | 1.479 | 1.812 | 7,102 / 7,102 / 7,102 |
| `dataframe.page.middle` | 1.367 | 1.474 | 1.503 | 7,577 / 7,577 / 7,577 |
| `dataframe.page.last` | 1.267 | 1.426 | 1.832 | 7,598 / 7,598 / 7,598 |
| `dataframe.page.sort_first` | 90.069 | 93.810 | 95.894 | 7,527 / 7,527 / 7,527 |
| `dataframe.page.sort_cached` | 2.078 | 2.266 | 3.032 | 7,527 / 7,527 / 7,527 |
| `dataframe.page.filter` | 31.067 | 32.855 | 33.690 | 7,025 / 7,025 / 7,026 |
| `dataframe.summary` | 117.766 | 120.774 | 124.032 | 1,218 / 1,218 / 1,218 |

### Interrupt

Latency is measured from sending `interrupt` until the infinite-loop `execute` response arrives.

| Min ms | Median ms | Max ms | Execute response bytes (median) | Interrupt response bytes (median) |
|---:|---:|---:|---:|---:|
| 15.232 | 15.994 | 16.514 | 284 | 86 |

## 1,000,000 rows — warm inspection (5 runs)

| Request | Min ms | Median ms | Max ms | Response bytes min/median/max |
|---|---:|---:|---:|---:|
| `variables.list` | 0.987 | 1.099 | 1.374 | 326 / 326 / 326 |
| `dataframe.metadata` | 0.926 | 1.033 | 1.118 | 788 / 789 / 789 |
| `dataframe.page.first` | 1.277 | 1.297 | 1.451 | 7,149 / 7,149 / 7,149 |
| `dataframe.page.middle` | 1.332 | 1.535 | 1.676 | 7,514 / 7,514 / 7,514 |
| `dataframe.page.last` | 1.362 | 1.493 | 1.661 | 7,640 / 7,640 / 7,640 |
| `dataframe.page.sort_first` | 192.305 | 194.874 | 198.100 | 7,549 / 7,549 / 7,549 |
| `dataframe.page.sort_cached` | 2.105 | 2.522 | 2.631 | 7,549 / 7,549 / 7,549 |
| `dataframe.page.filter` | 61.277 | 63.047 | 64.777 | 6,940 / 6,940 / 6,941 |
| `dataframe.summary` | 221.008 | 227.631 | 232.360 | 1,212 / 1,212 / 1,212 |

### Interrupt

Latency is measured from sending `interrupt` until the infinite-loop `execute` response arrives.

| Min ms | Median ms | Max ms | Execute response bytes (median) | Interrupt response bytes (median) |
|---:|---:|---:|---:|---:|
| 15.168 | 15.866 | 16.545 | 284 | 86 |

Response sizes are exact UTF-8 NDJSON line lengths, including the trailing newline. Uncached sort and filter samples clear the page cache with a no-op execute before each run.
