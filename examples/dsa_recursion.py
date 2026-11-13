# vrun — practice: recursion, divide and conquer, backtracking.
# Ctrl+Alt+V traces a cell. Recursive code gets a Recursion tree: one box
# per call with its arguments, the returned value under it, the calls on the
# stack highlighted. Click a box to jump to that call; ↑ runs until the
# current call returns, ↓ steps over a call.

# %% 1. Fibonacci — the same calls are made again and again
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


print(fib(5))

# %% 2. Fibonacci with a memo — compare the size of the tree with cell 1
memo = {}


def fib_memo(n):
    if n in memo:
        return memo[n]
    if n < 2:
        return n
    memo[n] = fib_memo(n - 1) + fib_memo(n - 2)
    return memo[n]


print(fib_memo(8))

# %% 3. Merge sort — split, sort both halves, merge
def merge_sort(a):
    if len(a) <= 1:
        return a
    mid = len(a) // 2
    left = merge_sort(a[:mid])
    right = merge_sort(a[mid:])
    merged = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            merged.append(left[i])
            i += 1
        else:
            merged.append(right[j])
            j += 1
    merged.extend(left[i:])
    merged.extend(right[j:])
    return merged


print(merge_sort([38, 27, 43, 3, 9, 82, 10]))

# %% 4. Backtracking — all permutations (choose, explore, un-choose)
def permute(nums):
    result = []
    path = []
    used = [False] * len(nums)

    def backtrack():
        if len(path) == len(nums):
            result.append(path[:])
            return
        for i in range(len(nums)):
            if used[i]:
                continue
            used[i] = True
            path.append(nums[i])
            backtrack()
            path.pop()          # un-choose
            used[i] = False

    backtrack()
    return result


print(permute([1, 2, 3]))

# %% 5. Exercises
# a) Power set: all subsets of [1, 2, 3] with the same choose / un-choose idea.
# b) Count the calls of fib(10) with and without the memo (len(memo) helps).
# c) Quick sort: pick a[hi] as pivot, partition, recurse on both sides.
