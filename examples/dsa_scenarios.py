# PyLive Inspector — more learner-style DSA programs (used to check the visualizer).

# %% Linked list with a wrapper class
class Node:
    def __init__(self, data):
        self.data = data
        self.next = None


class LinkedList:
    def __init__(self):
        self.head = None

    def append(self, data):
        node = Node(data)
        if self.head is None:
            self.head = node
            return
        cur = self.head
        while cur.next:
            cur = cur.next
        cur.next = node


ll = LinkedList()
for x in [3, 1, 4]:
    ll.append(x)

# %% BST with a wrapper class
class TreeNode:
    def __init__(self, key):
        self.key = key
        self.left = None
        self.right = None


class BST:
    def __init__(self):
        self.root = None

    def insert(self, key):
        if self.root is None:
            self.root = TreeNode(key)
            return
        cur = self.root
        while True:
            if key < cur.key:
                if cur.left is None:
                    cur.left = TreeNode(key)
                    return
                cur = cur.left
            else:
                if cur.right is None:
                    cur.right = TreeNode(key)
                    return
                cur = cur.right


tree = BST()
for k in [5, 2, 8, 1, 3]:
    tree.insert(k)

# %% Stack and queue with lists
stack = []
for ch in "([{}])":
    if ch in "([{":
        stack.append(ch)
    else:
        stack.pop()
queue = [1, 2, 3]
queue.pop(0)

# %% Merge sort (recursion)
def merge_sort(a):
    if len(a) <= 1:
        return a
    mid = len(a) // 2
    left = merge_sort(a[:mid])
    right = merge_sort(a[mid:])
    out = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            out.append(left[i])
            i += 1
        else:
            out.append(right[j])
            j += 1
    return out + left[i:] + right[j:]


result = merge_sort([5, 2, 9, 1, 6])

# %% Dijkstra with heapq
import heapq

graph = {"A": {"B": 4, "C": 1}, "B": {"D": 1}, "C": {"B": 2, "D": 5}, "D": {}}
dist = {v: float("inf") for v in graph}
dist["A"] = 0
pq = [(0, "A")]
while pq:
    d, u = heapq.heappop(pq)
    if d > dist[u]:
        continue
    for v, w in graph[u].items():
        if d + w < dist[v]:
            dist[v] = d + w
            heapq.heappush(pq, (dist[v], v))

# %% Grid BFS
from collections import deque

grid = [
    [0, 0, 1, 0],
    [1, 0, 1, 0],
    [0, 0, 0, 0],
]
seen = [[False] * 4 for _ in range(3)]
q = deque([(0, 0)])
seen[0][0] = True
while q:
    r, c = q.popleft()
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nr, nc = r + dr, c + dc
        if 0 <= nr < 3 and 0 <= nc < 4 and not seen[nr][nc] and grid[nr][nc] == 0:
            seen[nr][nc] = True
            q.append((nr, nc))

# %% Two pointers
nums = [1, 2, 4, 7, 11, 15]
target = 15
l, r = 0, len(nums) - 1
while l < r:
    s = nums[l] + nums[r]
    if s == target:
        break
    if s < target:
        l += 1
    else:
        r -= 1

# %% Reading input like a judge problem
n = int(input())
arr = list(map(int, input().split()))
print(sum(arr) / n)
