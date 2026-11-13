# vrun — practice: sorting, searching and two pointers.
# Put the cursor in a cell and press Ctrl+Alt+V (Visualize). In the
# Visualizer tab: ← / → step, ↓ steps over a call, ↑ runs until the function
# returns, a click on a code line runs to it. Swaps slide, pointers move, and
# the line about to run shows its values (arr[j] = 5). Turn on Live visualize
# and edit the input lists: the picture follows as you type.

# %% 1. Bubble sort — watch the largest value bubble to the end
arr = [5, 1, 4, 2, 8, 3]
n = len(arr)
for i in range(n):
    swapped = False
    for j in range(n - i - 1):
        if arr[j] > arr[j + 1]:
            arr[j], arr[j + 1] = arr[j + 1], arr[j]
            swapped = True
    if not swapped:          # already sorted: stop early
        break
print(arr)

# %% 2. Insertion sort — the sorted part grows on the left
a = [7, 3, 9, 1, 6, 2]
for i in range(1, len(a)):
    key = a[i]
    j = i - 1
    while j >= 0 and a[j] > key:
        a[j + 1] = a[j]      # shift right
        j -= 1
    a[j + 1] = key
print(a)

# %% 3. Binary search — lo, mid and hi close in on the target
nums = [1, 3, 5, 7, 9, 11, 13, 15, 17]
target = 13
lo, hi = 0, len(nums) - 1
found = -1
while lo <= hi:
    mid = (lo + hi) // 2
    if nums[mid] == target:
        found = mid
        break
    if nums[mid] < target:
        lo = mid + 1
    else:
        hi = mid - 1
print("found at", found)

# %% 4. Two pointers — a pair with a given sum in a sorted list
nums = [1, 2, 4, 6, 8, 9, 14, 15]
target = 13
left, right = 0, len(nums) - 1
while left < right:
    total = nums[left] + nums[right]
    if total == target:
        break
    if total < target:
        left += 1
    else:
        right -= 1
print(left, right)

# %% 5. Sliding window — longest substring without repeating characters
s = "abcabcbb"
last_seen = {}
left = 0
best = 0
for right, ch in enumerate(s):
    if ch in last_seen and last_seen[ch] >= left:
        left = last_seen[ch] + 1
    last_seen[ch] = right
    best = max(best, right - left + 1)
print(best)

# %% 6. Exercises
# a) Selection sort: find the smallest value of a[i:] and swap it to i.
# b) Binary search for the FIRST position of a value that appears several times.
# c) Is "A man, a plan, a canal: Panama" a palindrome? Use two pointers that
#    skip non-letters (str.isalnum) and compare lower-case characters.
