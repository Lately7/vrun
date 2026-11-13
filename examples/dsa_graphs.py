# vrun — practice: graphs and grids.
# Ctrl+Alt+V traces a cell (in a fresh namespace: each cell imports what it
# uses). Graph dicts are drawn as graphs: vertices in
# `visited` are filled, the ones in `queue` / `stack` outlined, `dist` is
# written under each vertex. On a grid, cells in `visited` and `queue` are
# coloured. Union-find `parent` arrays are drawn as a forest.

# %% 1. BFS — shortest number of edges from A
from collections import deque

graph = {
    "A": ["B", "C"],
    "B": ["A", "D", "E"],
    "C": ["A", "F"],
    "D": ["B"],
    "E": ["B", "F"],
    "F": ["C", "E"],
}
dist = {"A": 0}
queue = deque(["A"])
visited = {"A"}
while queue:
    u = queue.popleft()
    for v in graph[u]:
        if v not in visited:
            visited.add(v)
            dist[v] = dist[u] + 1
            queue.append(v)
print(dist)

# %% 2. DFS (recursive) — visiting order
tree_graph = {0: [1, 2], 1: [3, 4], 2: [5], 3: [], 4: [], 5: []}
seen = set()
order = []


def dfs(u):
    seen.add(u)
    order.append(u)
    for v in tree_graph[u]:
        if v not in seen:
            dfs(v)


dfs(0)
print(order)

# %% 3. Number of islands — BFS on a grid
from collections import deque

grid = [
    ["1", "1", "0", "0", "0"],
    ["1", "1", "0", "0", "1"],
    ["0", "0", "1", "0", "1"],
    ["0", "0", "0", "1", "1"],
]
rows, cols = len(grid), len(grid[0])
visited = set()
islands = 0
for r in range(rows):
    for c in range(cols):
        if grid[r][c] == "1" and (r, c) not in visited:
            islands += 1
            queue = deque([(r, c)])
            visited.add((r, c))
            while queue:
                cr, cc = queue.popleft()
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr, nc = cr + dr, cc + dc
                    if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == "1" and (nr, nc) not in visited:
                        visited.add((nr, nc))
                        queue.append((nr, nc))
print(islands)

# %% 4. Dijkstra — shortest paths with a priority queue
import heapq

roads = {
    "A": [("B", 4), ("C", 2)],
    "B": [("C", 5), ("D", 10)],
    "C": [("E", 3)],
    "D": [("F", 11)],
    "E": [("D", 4)],
    "F": [],
}
dist = {v: float("inf") for v in roads}
dist["A"] = 0
pq = [(0, "A")]
while pq:
    d, u = heapq.heappop(pq)
    if d > dist[u]:
        continue
    for v, w in roads[u]:
        if d + w < dist[v]:
            dist[v] = d + w
            heapq.heappush(pq, (dist[v], v))
print(dist)

# %% 5. Union-find — which edge closes a cycle?
n = 6
edges = [(0, 1), (1, 2), (3, 4), (2, 0), (4, 5)]
parent = list(range(n))


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]   # path halving
        x = parent[x]
    return x


cycle = None
for a, b in edges:
    ra, rb = find(a), find(b)
    if ra == rb:
        cycle = (a, b)
        break
    parent[rb] = ra
print(cycle, parent)

# %% 6. Exercises
# a) Keep a `parent` dict in BFS and rebuild the path from A to F into a list
#    named `path` (it is drawn in red on the graph).
# b) Topological order of {"wake": ["coffee"], "coffee": ["code"], "code": []}.
# c) Count connected components with union-find instead of BFS.
