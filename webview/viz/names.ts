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
/** Any container of nodes still to process: tree / list nodes in it are outlined like graph frontier vertices. */
export const WAITING_NAME = new RegExp(`${FRONTIER.source}|${QUEUE_NAME.source}|${HEAP_NAME.source}`, 'i');
export const ROOT_NAME = /^(root|tree|head|lst|linked|ll|graph|g|adj|trie)$/i;

/**
 * Ints that bound a range of a sequence; they need not appear inside a
 * subscript. Lower case only: R, C, N are sizes (R, C = len(grid), ...).
 */
export const BOUND_NAME = /^(lo|hi|low|high|left|right|l|r|start|end|begin|mid)$/;
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
export const EDGE_LIST_NAME = /^(edges|edge_list|edgelist|connections|roads|links|mst|mst_edges|tree_edges)$/i;
export const LEVEL_ORDER_NAME = /^(root|tree|nodes|bt|binary_tree|level_order)$/i;
/** Containers that hold a graph even when the data alone could be anything (a dict of lists, a list of lists). */
export const GRAPH_NAME =
  /^(graph|g|adj|adjacency|adj_list|adjlist|adj_map|neighbors|neighbours|nbrs|children|prereq|prereqs|prerequisites|deps|dependencies|roads|routes|flights|connections|links)$|_graph$|^graph_/i;
/** A list of neighbour lists by name. Narrower: prerequisites / roads as a list of lists are usually [a, b] pairs. */
export const ADJ_LIST_NAME = /^(graph|g|adj|adjacency|adj_list|adjlist|neighbors|neighbours|nbrs|children)$|_graph$|^graph_|^adj_/i;
/** Pairs drawn as points (y against x) rather than as a table. */
export const POINT_NAME = /^(points|pts|coords|coordinates|xy|xys|samples|data_points|curve)$/i;
/** A list of strings that is a 2-D map of characters. */
export const GRID_NAME = /^(grid|board|maze|matrix|map|world|picture)$/i;
/** Visiting / processing orders: vertex ids, not quantities to plot. */
export const ORDER_NAME = /^(order|topo|topo_order|toposort|result_order|visit_order|bfs_order|dfs_order)$/i;

/** Fields of a trie node that mark the end of a word when truthy. */
export const END_FIELD = /^(end|is_end|is_word|isEnd|isWord|is_end_of_word|end_of_word|terminal|is_terminal|word)$/;
/** Keys of a nested-dict trie that mark the end of a word. */
export const END_KEY = /^(\$|#|\*|end|_end|END)$/;
