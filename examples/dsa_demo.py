# Veil — data structures & algorithms demo.
# Put the cursor in a cell and run "Veil: Visualize Algorithm" (Ctrl+Alt+V),
# or turn on "Veil: Toggle Live Visualize" and edit the input data.

# %% Bubble sort — bars + index pointers i, j
arr = [5, 1, 4, 2, 8, 3]
n = len(arr)
for i in range(n):
    for j in range(n - i - 1):
        if arr[j] > arr[j + 1]:
            arr[j], arr[j + 1] = arr[j + 1], arr[j]
print(arr)

# %% Binary search — number line + lo / mid / hi pointers
nums = [1, 3, 5, 7, 9, 11, 13, 15]
target = 11
lo, hi = 0, len(nums) - 1
while lo <= hi:
    mid = (lo + hi) // 2
    if nums[mid] == target:
        break
    if nums[mid] < target:
        lo = mid + 1
    else:
        hi = mid - 1
print("found at", mid)

# %% BFS on a graph — visited / queue highlighting
from collections import deque

graph = {"A": ["B", "C"], "B": ["D", "E"], "C": ["F"], "D": [], "E": ["F"], "F": []}
visited = set()
queue = deque(["A"])
order = []
while queue:
    node = queue.popleft()
    if node in visited:
        continue
    visited.add(node)
    order.append(node)
    for nb in graph[node]:
        queue.append(nb)
print(order)

# %% Binary search tree — tree layout
class TreeNode:
    def __init__(self, val):
        self.val = val
        self.left = None
        self.right = None


def insert(root, val):
    if root is None:
        return TreeNode(val)
    if val < root.val:
        root.left = insert(root.left, val)
    else:
        root.right = insert(root.right, val)
    return root


root = None
for v in [8, 3, 10, 1, 6, 14, 4, 7]:
    root = insert(root, v)

# %% Reverse a linked list — pointers prev / cur
class ListNode:
    def __init__(self, val, next=None):
        self.val = val
        self.next = next


head = ListNode(1, ListNode(2, ListNode(3, ListNode(4))))
prev, cur = None, head
while cur:
    nxt = cur.next
    cur.next = prev
    prev, cur = cur, nxt
head = prev

# %% Dynamic programming — 0/1 knapsack table
weights = [1, 3, 4]
values = [15, 20, 30]
cap = 4
dp = [[0] * (cap + 1) for _ in range(len(weights) + 1)]
for i in range(1, len(weights) + 1):
    for w in range(cap + 1):
        dp[i][w] = dp[i - 1][w]
        if weights[i - 1] <= w:
            dp[i][w] = max(dp[i][w], dp[i - 1][w - weights[i - 1]] + values[i - 1])
print(dp[-1][-1])

# %% Function graph — y = x^2 - 4 on a grid
xs = [x / 2 for x in range(-8, 9)]
ys = [x * x - 4 for x in xs]
