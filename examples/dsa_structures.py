# vrun — practice: linked lists, stacks, trees, heaps, tries.
# Ctrl+Alt+V traces a cell. Objects with `next` are drawn as linked lists,
# with `left` / `right` or `children` as trees; a list named `heap` is drawn
# as a binary heap; variables that point at nodes label them.

# %% 1. Reverse a linked list — prev, cur and nxt move along
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

# %% 2. Stack — balanced brackets
text = "{[()()]}"
stack = []
pairs = {")": "(", "]": "[", "}": "{"}
balanced = True
for ch in text:
    if ch in "([{":
        stack.append(ch)
    elif not stack or stack.pop() != pairs[ch]:
        balanced = False
        break
print(balanced and not stack)

# %% 3. Binary search tree — insert, then search
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

node = root
while node and node.val != 7:
    node = node.left if 7 < node.val else node.right

# %% 4. Binary heap — watch values sift up and down
# Written out by hand: heapq.heappush / heappop run in C, all in one step,
# so there would be no swaps to watch. Each swap here is a step.
heap = []


def heap_push(x):
    heap.append(x)                 # a new leaf ...
    i = len(heap) - 1
    while i > 0:                   # ... sifts up while it is smaller than its parent
        parent = (i - 1) // 2
        if heap[parent] <= heap[i]:
            break
        heap[i], heap[parent] = heap[parent], heap[i]
        i = parent


def heap_pop():
    top = heap[0]
    if len(heap) == 1:
        return heap.pop()
    heap[0] = heap.pop()           # the last leaf moves to the root ...
    i = 0
    while True:                    # ... and sifts down below its smaller child
        left, right = 2 * i + 1, 2 * i + 2
        small = i
        if left < len(heap) and heap[left] < heap[small]:
            small = left
        if right < len(heap) and heap[right] < heap[small]:
            small = right
        if small == i:
            break
        heap[i], heap[small] = heap[small], heap[i]
        i = small
    return top


for x in [5, 3, 8, 1, 9, 2]:
    heap_push(x)
smallest = [heap_pop() for _ in range(3)]
print(smallest, heap)   # the same result as heapq: [1, 2, 3] [5, 9, 8]

# %% 5. Trie — words that share a prefix share a path
class TrieNode:
    def __init__(self):
        self.children = {}
        self.end = False


trie = TrieNode()
for word in ["car", "cat", "do", "dog"]:
    node = trie
    for ch in word:
        if ch not in node.children:
            node.children[ch] = TrieNode()
        node = node.children[ch]
    node.end = True

# %% 6. Exercises
# a) Find the middle of a linked list with a slow and a fast pointer.
# b) In-order traversal of the BST into a list (it comes out sorted).
# c) A min-stack: push, pop and get the minimum in O(1).
