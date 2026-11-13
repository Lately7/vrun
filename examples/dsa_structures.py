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

# %% 4. Binary heap with heapq — watch values sift up and down
import heapq

heap = []
for x in [5, 3, 8, 1, 9, 2]:
    heapq.heappush(heap, x)
smallest = [heapq.heappop(heap) for _ in range(3)]
print(smallest, heap)

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
