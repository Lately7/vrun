/**
 * Variable-name conventions the views rely on, in one place so the array,
 * matrix and graph views agree (a `visited` set fills graph vertices and
 * grid cells alike). DOM-free.
 */

export const VISITED = /^(visited|seen|done|closed|explored|marked|vis)$/i;
export const FRONTIER = /^(queue|q|stack|st|frontier|open|open_set|heap|pq|dq|to_visit|todo)$/i;
// Only consecutive-vertex sequences: a BFS `order` is not a path.
export const PATH = /^(path|best_path|shortest_path|cycle)$/i;
/** The vertex being expanded. */
export const CURRENT = /^(node|u|cur|curr|current|vertex|src)$/i;
/** The vertex being looked at from the current one. */
export const NEIGHBOR = /^(v|nb|nei|neighbor|neighbour|w|nxt|next_node|to|child)$/i;
export const DIST = /^(dist|distance|distances|d|cost|costs|level|depth|parent|prev)$/i;

export const HEAP_NAME = /(^|_)(heap|pq|minheap|maxheap|priority_queue)$/i;
/** Containers of work items: indices into them are not array positions. */
export const QUEUE_NAME = /^(q|queue|stack|st|frontier|todo|to_visit|dq|open|open_set)$/i;
export const ROOT_NAME = /^(root|tree|head|lst|linked|ll|graph|g|adj|trie)$/i;

/** Ints that bound a range of a sequence; they need not appear inside a subscript. */
export const BOUND_NAME = /^(lo|hi|low|high|left|right|l|r|start|end|begin|mid)$/i;
/** Bound pairs whose range is shaded on arrays and strings. */
export const BOUND_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['lo', 'hi'],
  ['low', 'high'],
  ['left', 'right'],
  ['l', 'r'],
  ['start', 'end'],
  ['begin', 'end'],
];

export const UNION_FIND_NAME = /^(parent|parents|par|fa|uf|leader|root|roots|boss)$/i;
export const EDGE_LIST_NAME = /^(edges|edge_list|edgelist|connections|roads|links)$/i;
export const LEVEL_ORDER_NAME = /^(root|tree|nodes|bt|binary_tree|level_order)$/i;

/** Fields of a trie node that mark the end of a word when truthy. */
export const END_FIELD = /^(end|is_end|is_word|isEnd|isWord|is_end_of_word|end_of_word|terminal|is_terminal|word)$/;
/** Keys of a nested-dict trie that mark the end of a word. */
export const END_KEY = /^(\$|#|\*|end|_end|END)$/;
