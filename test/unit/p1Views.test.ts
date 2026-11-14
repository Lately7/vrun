/**
 * P1 fixes in the views (webview/variables.ts, webview/format.ts,
 * webview/viz): strings quoted, deque not drawn like a set, built-in names
 * tagged, nodes and tuples inside stacks / queues / heaps shown by value,
 * waiting tree nodes outlined, doubly linked lists with prev links and
 * head / tail labels, cut containers said instead of drawn as complete, and
 * the ghost cell one past the end of an array.
 *
 * Modules that build DOM nodes are loaded with require(): the root
 * tsconfig has no DOM lib, and a minimal fake document below is enough for
 * h() / s() and for reading the result back.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Encoded, type Heap, type HeapNode, fmtPreview, fmtPy, shadowsBuiltin } from '../../webview/format';
import { type Var, ambiguousStr, itemType, memberRefs, pyText, shortScalar } from '../../webview/viz/common';
import { FRONTIER, WAITING_NAME } from '../../webview/viz/names';
import { type FrameLike, sequencePointers, truth } from '../../webview/viz/pointers';
import { cellMarks } from '../../webview/viz/shapes';
import { parseSource } from '../../webview/viz/sourceHints';

// -- a minimal DOM, enough for webview/dom.ts --------------------------------

class FakeNode {
  parentNode: FakeEl | null = null;
  constructor(readonly nodeName: string, readonly data = '') {}
  get textContent(): string {
    return this.data;
  }
}

class FakeEl extends FakeNode {
  childNodes: FakeNode[] = [];
  private attrs = new Map<string, string>();
  style = { setProperty: (): void => undefined };
  classList = {
    add: (c: string): void => this.setAttribute('class', `${this.getAttribute('class') ?? ''} ${c}`.trim()),
    contains: (c: string): boolean => this.classes().includes(c),
  };
  constructor(tag: string) {
    super(tag);
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  get children(): FakeEl[] {
    return this.childNodes.filter((c): c is FakeEl => c instanceof FakeEl);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  classes(): string[] {
    return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(): void {}
  appendChild(c: FakeNode): FakeNode {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  append(...cs: Array<FakeNode | string>): void {
    for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeNode('#text', c) : c);
  }
  prepend(...cs: Array<FakeNode | string>): void {
    this.childNodes.unshift(...cs.map((c) => (typeof c === 'string' ? new FakeNode('#text', c) : c)));
  }
  removeChild(c: FakeNode): FakeNode {
    this.childNodes = this.childNodes.filter((x) => x !== c);
    return c;
  }
  closest(): null {
    return null;
  }
}

const g = globalThis as Record<string, unknown>;
g.document = {
  createElement: (t: string) => new FakeEl(t),
  createElementNS: (_ns: string, t: string) => new FakeEl(t),
  createTextNode: (t: string) => new FakeNode('#text', t),
};
g.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });

/** Every element under `el` (itself included) that matches. */
function all(el: FakeEl, pred: (e: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
  if (pred(el)) out.push(el);
  for (const c of el.children) all(c, pred, out);
  return out;
}
const byClass = (el: FakeEl, cls: string) => all(el, (e) => e.classes().includes(cls));
/** Own text of each <text> (a <title> tooltip inside it left out). */
const texts = (el: FakeEl, tag = 'text') =>
  all(el, (e) => e.nodeName === tag).map((e) => e.childNodes.filter((c) => !(c instanceof FakeEl)).map((c) => c.textContent).join(''));

// -- the DOM-building modules -------------------------------------------------

interface StructureCtx {
  source?: string;
  frames?: Array<{ func: string; line?: number; locals: Array<[string, Encoded]> }>;
  event?: 'line' | 'return' | 'exception';
}
interface Pointer {
  name: string;
  index: number;
  outOfRange?: boolean;
}
const structures = require('../../webview/viz/structures') as {
  renderStructures: (vars: Var[], heap: Heap, prev: Heap | undefined, state: { modes: Map<string, string> }, rerender: () => void, ctx?: StructureCtx) => FakeEl;
};
const arrayView = require('../../webview/viz/arrayView') as {
  cellLabels: (items: Encoded[], heap?: Heap, chars?: boolean) => string[];
  pointerText: (p: Pointer, shown: number, total: number) => string;
  renderArray: (o: { name: string; items: Encoded[]; total: number; pointers: Pointer[]; mode: 'bars' | 'cells'; heap?: Heap }) => FakeEl;
  visibleSpans: (n: number, pointers: number[], changed?: number[], max?: number) => Array<[number, number]>;
};
const treeView = require('../../webview/viz/treeView') as {
  prevLinks: (order: number[], heap: Heap, cycleTo: number | undefined, fromHead: boolean, label: (r: number) => string, elsewhere?: Set<number>) => Array<{ from: number; to?: number; none?: boolean; outside?: number; hot: boolean }>;
};

const ref = (id: number) => ({ ref: id });
const list = (items: Encoded[], len = items.length): HeapNode => ({ kind: 'list', items, len });
const tuple = (items: Encoded[]): HeapNode => ({ kind: 'tuple', items, len: items.length });
const obj = (type: string, fields: Record<string, Encoded>): HeapNode => ({ kind: 'object', type, fields: Object.entries(fields) });
const heapOf = (nodes: Record<number, HeapNode>): Heap => Object.fromEntries(Object.entries(nodes));
const draw = (vars: Var[], heap: Heap, ctx?: StructureCtx) => structures.renderStructures(vars, heap, undefined, { modes: new Map() }, () => undefined, ctx);
const titles = (root: FakeEl) => byClass(root, 'viz-card').map((c) => c.children[0]?.textContent ?? '');

describe('Variables: values as Python prints them (item 3)', () => {
  it('quotes strings in previews, keys and values; deque and empty set read as themselves', () => {
    assert.equal(fmtPreview('list', ['10', '2', '33'], 3), "['10', '2', '33']");
    assert.equal(fmtPreview('list', [10, 2, 33], 3), '[10, 2, 33]');
    assert.equal(fmtPreview('deque', [1, 2, 3], 3), 'deque([1, 2, 3])');
    assert.equal(fmtPreview('set', [1, 2, 3], 3), '{1, 2, 3}');
    assert.equal(fmtPreview('set', [], 0), 'set()');
    assert.equal(fmtPreview('frozenset', [1], 1), 'frozenset({1})');
    assert.equal(fmtPreview('tuple', [1], 1), '(1,)');
    assert.equal(fmtPreview('list', [1, 2], 10), '[1, 2, …]');
    assert.equal(fmtPreview('dict', ['acc', 'f1'], 2, [0.9, 0.8]), "{'acc': 0.9, 'f1': 0.8}");
    // Values not sent (containers): still a dict, not a set of keys.
    assert.equal(fmtPreview('dict', ['a', 'b'], 2), "{'a': …, 'b': …}");
    assert.equal(fmtPy('abba\n'), "'abba\\n'");
  });

  it('renders the rows of the Variables tab that way, and tags names that hide a built-in (item 11)', () => {
    const { VariablesView } = require('../../webview/variables') as {
      VariablesView: new (open: () => void, viz: () => void, features: () => { dataframe: boolean; visualizer: boolean }) => {
        el: FakeEl;
        setList: (l: { variables: Array<Record<string, unknown>>; omitted: number; session: string; revision: number }) => void;
      };
    };
    const view = new VariablesView(() => undefined, () => undefined, () => ({ dataframe: true, visualizer: true }));
    view.setList({
      variables: [
        { name: 'a', type: 'list', kind: 'list', len: 5, preview: ['10', '2', '33', '4', '9'] },
        { name: 'b', type: 'list', kind: 'list', len: 5, preview: [2, 4, 9, 10, 33] },
        { name: 'word', type: 'str', kind: 'str', len: 5, value: 'abba\n' },
        { name: 'q', type: 'collections.deque', kind: 'deque', len: 3, preview: [1, 2, 3] },
        { name: 'max', type: 'int', kind: 'number', value: 0 },
        { name: 'input', type: 'builtin_function_or_method', kind: 'function', value: { $t: 'fn', v: 'TextIOWrapper.readline' } },
        { name: 'len', type: 'builtin_function_or_method', kind: 'function', value: { $t: 'fn', v: 'len' } },
        { name: 'sum', type: 'function', kind: 'function', value: { $t: 'fn', v: 'sum' } },
      ],
      omitted: 0,
      session: 's',
      revision: 1,
    });
    const rows = all(view.el, (e) => e.nodeName === 'tr').map((tr) => ({
      name: byClass(tr, 'name')[0]?.textContent ?? '',
      value: byClass(tr, 'value')[0]?.textContent ?? '',
    }));
    const row = (n: string) => rows.find((r) => r.name.replace(/[▸▾]|shadows built-in/g, '').trim() === n)!;
    assert.equal(row('a').value, "['10', '2', '33', '4', '9']");
    assert.equal(row('b').value, '[2, 4, 9, 10, 33]');
    assert.equal(row('word').value, "'abba\\n'");
    assert.equal(row('q').value, 'deque([1, 2, 3])');
    assert.match(row('max').name, /shadows built-in/);
    assert.match(row('input').name, /shadows built-in/);
    assert.doesNotMatch(row('len').name, /shadows built-in/); // the built-in itself
    assert.match(row('sum').name, /shadows built-in/); // the learner's own def sum(xs)
    assert.doesNotMatch(row('a').name, /shadows built-in/);
  });

  it('shadowsBuiltin: only built-in names, not the built-in re-bound', () => {
    assert.equal(shadowsBuiltin('max', 0), true);
    assert.equal(shadowsBuiltin('list', { ref: 3 }), true);
    assert.equal(shadowsBuiltin('max', { $t: 'fn', v: 'max' }), false);
    assert.equal(shadowsBuiltin('total', 0), false);
  });
});

describe('cells of the visualizer: str quoted, nodes and tuples by value (items 3, 14)', () => {
  const heap = heapOf({
    1: obj('TreeNode', { val: 5, left: null, right: null }),
    2: tuple([1, 0, ref(1)]),
    3: tuple([2, 3]),
    4: tuple([ref(3), 4]),
    5: list([1, 10]),
    6: tuple([ref(4), 9]),
    7: tuple([1, '1']),
    8: tuple([1, 2, 3, 4]),
    9: obj('Graph', { adj: ref(5) }),
  });

  it('shortScalar shows values: node label, small tuples recursively two levels deep', () => {
    assert.equal(shortScalar(ref(1), heap), '5');
    assert.equal(shortScalar(ref(2), heap), '(1,0,5)');
    assert.equal(shortScalar(ref(4), heap), '((2,3),4)');
    assert.equal(shortScalar(ref(5), heap), '[1,10]');
    assert.equal(shortScalar(ref(6), heap), '((tuple[2],4),9)');
    assert.equal(shortScalar(ref(7), heap), "(1,'1')");
    assert.equal(shortScalar(ref(8), heap), 'tuple[4]');
    assert.equal(shortScalar(ref(9), heap), 'Graph'); // no label field: the type
  });

  it('pyText gives the whole value for tooltips', () => {
    assert.equal(pyText(ref(2), heap), '(1, 0, TreeNode(val=5))');
    assert.equal(pyText('10'), "'10'");
  });

  it('quotes every str of an array once one would read as another type', () => {
    assert.deepEqual(arrayView.cellLabels(['10', '2', 'abc']), ["'10'", "'2'", "'abc'"]);
    assert.deepEqual(arrayView.cellLabels(['a', 'b']), ['a', 'b']);
    assert.deepEqual(arrayView.cellLabels([10, '10']), ['10', "'10'"]);
    // A string's own characters stay bare; its '\n' is visible.
    assert.deepEqual(arrayView.cellLabels(['1', '\n', ' '], undefined, true), ['1', '\\n', '␣']);
    assert.equal(ambiguousStr(''), true);
    assert.equal(ambiguousStr('None'), true);
    assert.equal(ambiguousStr('-3.5'), true);
    assert.equal(ambiguousStr('abc'), false);
  });

  it("names what a container holds: 'list of str', 'deque of TreeNode'", () => {
    assert.equal(itemType(['10', { $t: 'str', v: 'x', len: 200 }], heap), 'str');
    assert.equal(itemType([ref(1), ref(1)], heap), 'TreeNode');
    assert.equal(itemType([ref(1), 3], heap), undefined);
    const root = draw([{ name: 'a', value: ref(20), depth: 0 }], { 20: list(['10', '2', '33']) });
    assert.match(titles(root)[0], /list of str · len 3/);
  });

  it('cells grow to fit a tuple label instead of spilling into the neighbours', () => {
    const svg = arrayView.renderArray({ name: 'pq', items: [ref(2), ref(4)], total: 2, pointers: [], mode: 'cells', heap });
    assert.deepEqual(texts(svg).slice(0, 4).filter((t) => t.startsWith('(')), ['(1,0,5)', '((2,3),4)']);
    const box = byClass(svg, 'cellbox')[0];
    assert.ok(Number(box.getAttribute('width')) >= 9 * 6.6, `cell width ${box.getAttribute('width')}`);
  });
});

describe('waiting nodes are outlined in the tree (item 14)', () => {
  // 1 -> (2, 3), 2 -> (4, 5); stack holds 2 and 4; pq holds (5, 0, node 3).
  const heap = heapOf({
    1: obj('TreeNode', { val: 1, left: ref(2), right: ref(3) }),
    2: obj('TreeNode', { val: 2, left: ref(4), right: ref(5) }),
    3: obj('TreeNode', { val: 3, left: null, right: null }),
    4: obj('TreeNode', { val: 4, left: null, right: null }),
    5: obj('TreeNode', { val: 5, left: null, right: null }),
    10: list([ref(2), ref(4)]),
    11: list([ref(12)]),
    12: tuple([5, 0, ref(3)]),
    13: obj('BSTIterator', { stack: ref(10) }),
  });

  it('memberRefs finds nodes in stacks, in (val, i, node) tuples and in self.stack', () => {
    assert.deepEqual([...memberRefs([{ name: 'stack', value: ref(10), depth: 0 }], heap, FRONTIER).keys()], [2, 4]);
    assert.deepEqual([...memberRefs([{ name: 'pq', value: ref(11), depth: 0 }], heap, WAITING_NAME)], [[3, 'pq']]);
    assert.deepEqual([...memberRefs([{ name: 'it', value: ref(13), depth: 0 }], heap, WAITING_NAME)], [[2, 'it.stack'], [4, 'it.stack']]);
    assert.equal(memberRefs([{ name: 'res', value: ref(10), depth: 0 }], heap, WAITING_NAME).size, 0);
  });

  it('marks them with the frontier class and says so in the subtitle', () => {
    const root = draw([{ name: 'root', value: ref(1), depth: 0 }, { name: 'stack', value: ref(10), depth: 0 }], heap);
    const tree = byClass(root, 'viz-card')[0];
    assert.match(tree.children[0].textContent, /outlined: in stack/);
    const outlined = byClass(tree, 'frontier').map((c) => c.childNodes[0]?.textContent);
    assert.deepEqual(outlined.sort(), ['2', '4']);
    const stackCard = byClass(root, 'viz-card').find((c) => c.children[0].textContent.startsWith('stack'))!;
    assert.match(stackCard.children[0].textContent, /list of TreeNode/);
    assert.deepEqual(byClass(stackCard, 'cell-text').map((t) => t.textContent), ['2', '4']);
  });
});

describe('doubly linked lists (item 16)', () => {
  const dnode = (val: number, prev: Encoded, next: Encoded) => obj('DNode', { val, prev, next });
  const healthy = () =>
    heapOf({
      1: obj('DoublyLinkedList', { head: ref(2), tail: ref(5), size: 4 }),
      2: dnode(1, null, ref(3)),
      3: dnode(2, ref(2), ref(4)),
      4: dnode(3, ref(3), ref(5)),
      5: dnode(4, ref(4), null),
    });
  const label = (h: Heap) => (r: number) => String(h[String(r)]?.fields?.[0][1]);

  it('prevLinks: a healthy list has only left-neighbour links', () => {
    const h = healthy();
    const links = treeView.prevLinks([2, 3, 4, 5], h, undefined, true, label(h));
    assert.deepEqual(links.map((l) => [l.from, l.to, l.hot]), [[1, 0, false], [2, 1, false], [3, 2, false]]);
  });

  it('prevLinks: remove() that forgot node.next.prev leaves a hot link to the removed node', () => {
    const h = healthy();
    h['2'] = dnode(1, null, ref(4)); // 1.next = 3, node 2 unlinked
    const links = treeView.prevLinks([2, 4, 5], h, undefined, true, label(h));
    assert.deepEqual(links.find((l) => l.from === 1), { from: 1, outside: 3, hot: true, why: '3.prev is 2, a node not in this list; it should be 1' });
    // The same nodes drawn again from the removed node's own variable are judged by the first card.
    assert.ok(treeView.prevLinks([3, 4, 5], h, undefined, false, label(h), new Set([4, 5])).every((l) => !l.hot));
  });

  it('prevLinks: prev None in the middle, and the head of a list drawn from its wrapper', () => {
    const h = healthy();
    h['4'] = dnode(3, null, ref(5));
    assert.deepEqual(treeView.prevLinks([2, 3, 4, 5], h, undefined, true, label(h)).filter((l) => l.hot).map((l) => [l.from, l.none]), [[2, true]]);
    h['2'] = dnode(1, ref(9), ref(3));
    h['9'] = dnode(0, null, ref(2));
    assert.equal(treeView.prevLinks([2, 3], h, undefined, true, label(h))[0].hot, true); // head.prev must be None
    assert.equal(treeView.prevLinks([2, 3], h, undefined, false, label(h))[0].hot, false); // drawn from a middle node
  });

  it('prevLinks: a prev field no node uses yet draws a plain singly linked list', () => {
    const h = heapOf({ 2: dnode(1, null, ref(3)), 3: dnode(2, null, null) });
    assert.deepEqual(treeView.prevLinks([2, 3], h, undefined, false, label(h)), []);
  });

  it('draws prev arcs, and labels head and tail as dll.head / dll.tail', () => {
    const root = draw([{ name: 'dll', value: ref(1), depth: 0 }], healthy());
    const card = byClass(root, 'viz-card')[0];
    assert.match(card.children[0].textContent, /size=4/);
    assert.equal(byClass(card, 'prev').length, 3);
    assert.equal(byClass(card, 'hot').length, 0);
    const labels = byClass(card, 'ptr-text').map((t) => t.textContent);
    assert.deepEqual(labels, ['dll.head', 'dll.tail']);
  });

  it('inside a method the labels read self.head / self.tail', () => {
    const frames = [
      { func: '<module>', locals: [['dll', ref(1)]] as Array<[string, Encoded]> },
      { func: 'push_back', locals: [['self', ref(1)], ['val', 5]] as Array<[string, Encoded]> },
    ];
    const vars: Var[] = [{ name: 'self', value: ref(1), depth: 1 }, { name: 'val', value: 5, depth: 1 }, { name: 'dll', value: ref(1), depth: 0 }];
    const root = draw(vars, healthy(), { frames });
    assert.deepEqual(byClass(root, 'ptr-text').map((t) => t.textContent), ['self.head', 'self.tail']);
  });

  it('a broken prev link is hot, and a tail left on a removed node is said', () => {
    const h = healthy();
    h['2'] = dnode(1, null, ref(4));
    h['4'] = dnode(3, ref(3), null); // the last node was removed too, tail not moved
    const root = draw([{ name: 'dll', value: ref(1), depth: 0 }], h);
    const card = byClass(root, 'viz-card')[0];
    assert.ok(byClass(card, 'hot').length >= 1);
    // Said in words under the drawing, not only in the red arc's tooltip.
    assert.deepEqual(byClass(card, 'hot-note').map((p) => p.textContent), [
      'broken link: 3.prev is 2, a node not in this list; it should be 1',
      'dll.tail → the node 4, which is not in this list',
    ]);
  });

  it('a healthy list gets no note', () => {
    const card = byClass(draw([{ name: 'dll', value: ref(1), depth: 0 }], healthy()), 'viz-card')[0];
    assert.equal(byClass(card, 'hot-note').length, 0);
  });

  it("inside the list's own method a mismatch is said calmly; once it returns, or from main(), it is red (review V2 #3)", () => {
    // review progs/dll_ops.py, push_front between `self.head.prev = node` and `self.head = node`.
    const h = healthy();
    h['2'] = dnode(1, ref(9), ref(3));
    h['9'] = dnode(0, null, ref(2));
    const vars: Var[] = [{ name: 'self', value: ref(1), depth: 1 }, { name: 'node', value: ref(9), depth: 1 }, { name: 'dll', value: ref(1), depth: 0 }];
    const frames = [
      { func: '<module>', line: 48, locals: [['dll', ref(1)]] as Array<[string, Encoded]> },
      { func: 'push_front', line: 28, locals: [['self', ref(1)], ['val', 0], ['node', ref(9)]] as Array<[string, Encoded]> },
    ];
    const card = byClass(draw(vars, h, { frames }), 'viz-card')[0];
    assert.equal(byClass(card, 'hot-note').length, 0);
    assert.equal(byClass(card, 'hot').length, 0);
    assert.equal(byClass(card, 'pending').length, 1);
    assert.deepEqual(byClass(card, 'pending-note').map((p) => p.textContent), ['not linked yet (inside push_front): 1.prev is 0, a node not in this list; it should be None']);
    // On push_front's return step what it left stays: red.
    const returned = byClass(draw(vars, h, { frames, event: 'return' }), 'viz-card')[0];
    assert.equal(byClass(returned, 'hot-note').length, 1);
    // A main() that only holds the list is not its method.
    const inMain = [frames[0], { func: 'main', line: 3, locals: [['dll', ref(1)]] as Array<[string, Encoded]> }];
    const red = byClass(draw([{ name: 'dll', value: ref(1), depth: 1 }], h, { frames: inMain }), 'viz-card')[0];
    assert.deepEqual(byClass(red, 'hot-note').map((p) => p.textContent), ['broken link: 1.prev is 0, a node not in this list; it should be None']);
  });

  it("a circular list's head does not draw a prev arc on top of the cycle path (review V2 #4)", () => {
    const h = heapOf({ 2: dnode(1, ref(4), ref(3)), 3: dnode(2, ref(2), ref(4)), 4: dnode(3, ref(3), ref(2)) });
    const card = byClass(draw([{ name: 'head', value: ref(2), depth: 0 }], h), 'viz-card')[0];
    assert.equal(byClass(card, 'prev').length, 2);
    assert.equal(byClass(card, 'hot').filter((e) => e.classes().includes('prev')).length, 0);
  });
});

describe('cut containers are said, not drawn as complete (item 12)', () => {
  it('lists: "N more not shown", and a pointer past the sent part says where it is', () => {
    const items = Array.from({ length: 64 }, (_, i) => i);
    const svg = arrayView.renderArray({ name: 'a', items, total: 200, pointers: [{ name: 'j', index: 67 }], mode: 'cells' });
    assert.ok(texts(svg).includes('… 136 more not shown'));
    assert.ok(texts(svg).includes('j=67 (beyond the 64 shown)'));
    assert.equal(arrayView.pointerText({ name: 'i', index: 3 }, 64, 200), 'i=3');
  });

  it('dicts: a last row with the number of keys not sent', () => {
    const entries: [Encoded, Encoded][] = Array.from({ length: 64 }, (_, i) => [i, i * i]);
    const root = draw([{ name: 'memo', value: ref(1), depth: 0 }], { 1: { kind: 'dict', entries, len: 71 } });
    assert.ok(byClass(root, 'cut-row').some((r) => r.textContent === '… 7 more keys not shown'));
  });

  it('grids: visited (64 of 278 shown), and the true size of a cut table', () => {
    const cells: Heap = {};
    const members: Encoded[] = [];
    for (let k = 0; k < 64; k++) {
      cells[String(100 + k)] = tuple([Math.floor(k / 8), k % 8]);
      members.push(ref(100 + k));
    }
    cells['1'] = { kind: 'set', items: members, len: 278 };
    const marks = cellMarks([{ name: 'visited', value: ref(1), depth: 0 }], cells, 8, 8);
    assert.deepEqual(marks.legend, [{ cls: 'visited', name: 'visited', shown: 64, total: 278 }]);
    const row = (k: number) => list(Array.from({ length: 64 }, () => k), 100);
    const heap: Heap = { 1: list(Array.from({ length: 64 }, (_, k) => ref(10 + k)), 100) };
    for (let k = 0; k < 64; k++) heap[String(10 + k)] = row(k);
    const root = draw([{ name: 'grid', value: ref(1), depth: 0 }], heap);
    assert.match(titles(root)[0], /100×100 \(first 64×64 shown\)/);
  });

  it('a list-of-lists graph says the vertices and visited members that were not sent', () => {
    const heap: Heap = { 1: list([ref(2), ref(3), ref(4)], 5), 2: list([1]), 3: list([2]), 4: list([0]), 9: { kind: 'set', items: [0, 1], len: 4 } };
    const root = draw([{ name: 'adj', value: ref(1), depth: 0 }, { name: 'visited', value: ref(9), depth: 0 }], heap);
    assert.match(titles(root)[0], /^adjgraph · 3 vertices \(list of lists\) · 2 more not shown · visited: 2 of 4 shown/);
  });

  it('a tree node whose children were not sent is marked, not drawn as a leaf', () => {
    const heap = heapOf({
      1: obj('TreeNode', { val: 1, left: ref(2), right: { ref: 3, missing: true } }),
      2: obj('TreeNode', { val: 2, left: null, right: null }),
    });
    const root = draw([{ name: 'root', value: ref(1), depth: 0 }], heap);
    assert.match(titles(root)[0], /some nodes not shown/);
    assert.equal(byClass(root, 'cut-mark').length, 1);
  });

  it('a variable whose object came after the object cap gets a placeholder card', () => {
    const root = draw([{ name: 'queue', value: { ref: 7, missing: true }, depth: 0 }, { name: 'a', value: ref(1), depth: 0 }], { 1: list([1, 2]) });
    const card = byClass(root, 'viz-card').find((c) => c.textContent.includes('not shown: too many objects'));
    assert.ok(card, titles(root).join(' | '));
    assert.match(card!.children[0].textContent, /^queue/);
  });
});

describe('the subscript that runs off the end (item 8)', () => {
  const src = 'nums = [4, 2, 7, 1]\nn = len(nums)\nfor i in range(n):\n    for j in range(n - i):\n        if nums[j] > nums[j + 1]:\n            nums[j], nums[j + 1] = nums[j + 1], nums[j]\n';
  const hints = parseSource(src);
  const at = (j: number): FrameLike[] => [{ func: '<module>', line: 5, locals: [['nums', ref(1)], ['n', 4], ['i', 0], ['j', j]] }];

  it('draws j+1 = len(nums) on the line about to run, marked out of range', () => {
    const { pointers } = sequencePointers(ref(1), 0, 4, at(3), hints);
    assert.deepEqual(pointers.map((p) => [p.name, p.index, p.outOfRange ?? false]), [['j', 3, false], ['j+1', 4, true]]);
    // Inside the list j + 1 is just the next cell, shown by j.
    assert.deepEqual(sequencePointers(ref(1), 0, 4, at(1), hints).pointers.map((p) => p.name), ['j']);
  });

  it('a guarded subscript (while i < n and a[i] ...) is not out of range', () => {
    const h2 = parseSource('a = [1, 2, 3, 4]\nn = len(a)\ni = 0\nwhile i < n and a[i] != 9:\n    i += 1\n');
    const { pointers } = sequencePointers(ref(1), 0, 4, [{ func: '<module>', line: 4, locals: [['a', ref(1)], ['n', 4], ['i', 4]] }], h2);
    assert.deepEqual(pointers.map((p) => [p.name, p.index, p.outOfRange ?? false]), [['i', 4, false]]);
  });

  it('a dashed ghost cell stands past the end, red when it is out of range', () => {
    const svg = arrayView.renderArray({ name: 'nums', items: [2, 4, 1, 7], total: 4, pointers: [{ name: 'j', index: 3 }, { name: 'j+1', index: 4, outOfRange: true }], mode: 'cells' });
    const ghost = byClass(svg, 'ghost');
    assert.equal(ghost.length, 1);
    assert.ok(ghost[0].classes().includes('hot'));
    assert.ok(texts(svg).includes('j+1=4 (out of range)'));
    const calm = arrayView.renderArray({ name: 'a', items: [1, 2], total: 2, pointers: [{ name: 'i', index: 2 }], mode: 'cells' });
    assert.equal(byClass(calm, 'ghost').length, 1);
    assert.equal(byClass(calm, 'hot').length, 0);
    assert.ok(texts(calm).includes('i=2'));
  });
});

describe('review fixes: guards, long rows, built-in defs, long dicts, wrappers', () => {
  const marks = (src: string, line: number, locals: Array<[string, Encoded]>, target: Encoded = ref(1), len = 4) =>
    sequencePointers(target, 0, len, [{ func: '<module>', line, locals }], parseSource(src)).pointers.map((p) => [p.name, p.index, p.outOfRange ?? false]);

  it('a guard on the loop variable keeps a correct bubble sort calm (item 8)', () => {
    // review progs/r_guard.py: `j < n - 1 and` is false when j + 1 == len.
    const src = 'nums = [4, 2, 7, 1]\nn = len(nums)\nfor i in range(n):\n    for j in range(n):\n        if j < n - 1 and nums[j] > nums[j + 1]:\n            nums[j], nums[j + 1] = nums[j + 1], nums[j]\n';
    assert.deepEqual(marks(src, 5, [['nums', ref(1)], ['n', 4], ['i', 0], ['j', 3]]), [['j', 3, false]]);
  });

  it('the Roman-numeral guard i < len(s) - 1 keeps s[i + 1] calm (item 8)', () => {
    // review progs/r_roman.py, the string's own pointers.
    const src = 'val = {"I": 1, "V": 5, "X": 10}\ns = "XIV"\ntotal = 0\nfor i in range(len(s)):\n    if i < len(s) - 1 and val[s[i]] < val[s[i + 1]]:\n        total -= val[s[i]]\n';
    assert.deepEqual(marks(src, 5, [['val', ref(9)], ['s', 'XIV'], ['total', 0], ['i', 2]], 'XIV', 3), [['i', 2, false]]);
  });

  it('a guard that lets the subscript run still marks it; or / if-else / callers do not', () => {
    const base = 'nums = [4, 2, 7, 1]\nn = len(nums)\nj = 3\n';
    const locals: Array<[string, Encoded]> = [['nums', ref(1)], ['n', 4], ['j', 3]];
    assert.deepEqual(marks(`${base}if j < n and nums[j + 1] > 0:\n    pass\n`, 4, locals), [['j+1', 4, true]]);
    assert.deepEqual(marks(`${base}if j >= n - 1 or nums[j] > nums[j + 1]:\n    pass\n`, 4, locals), [['j', 3, false]]);
    // Still drawn (a neutral ghost cell), not red.
    assert.deepEqual(marks(`${base}x = nums[j + 1] if j + 1 < n else 0\n`, 4, locals), [['j+1', 4, false]]);
    // The frame holding nums waits in a call: its line has not finished, nothing is certain.
    const src = `${base}def show(x):\n    return x\nif show(nums[j]) and nums[j + 1]:\n    pass\n`;
    const frames: FrameLike[] = [{ func: '<module>', line: 6, locals }, { func: 'show', line: 5, locals: [['x', 1]] }];
    assert.deepEqual(sequencePointers(ref(1), 0, 4, frames, parseSource(src)).pointers.map((p) => p.outOfRange ?? false), [false]);
  });

  it('a one-line if guards its body; a body whose condition holds still crashes', () => {
    // review progs/g_oneliner.py: Python never reads nums[4] here.
    const loop = 'nums = [4, 2, 7, 1]\nn = len(nums)\ntotal = 0\nfor j in range(n):\n';
    const locals: Array<[string, Encoded]> = [['nums', ref(1)], ['n', 4], ['total', 0], ['j', 3]];
    // j itself is drawn only where the code indexes with it plainly; j+1 is the cell.
    assert.deepEqual(marks(`${loop}    if j + 1 < n: total += nums[j + 1]\n`, 5, locals), [['j+1', 4, false]]);
    assert.deepEqual(marks(`${loop}    while j + 1 < n and j > 0: total += nums[j + 1]\n`, 5, locals), [['j+1', 4, false]]);
    assert.deepEqual(marks(`${loop}    if j + 1 <= n: total += nums[j + 1]\n`, 5, locals), [['j+1', 4, true]]);
    assert.deepEqual(marks(`${loop}    if j > 5 or j >= 0: total += nums[j + 1]\n`, 5, locals), [['j+1', 4, true]]);
    // A condition it cannot evaluate may skip the body.
    assert.deepEqual(marks(`${loop}    if ok(j): total += nums[j + 1]\n`, 5, locals), [['j+1', 4, false]]);
    // The read inside the condition itself is not guarded by it.
    assert.deepEqual(marks(`${loop}    if nums[j + 1] > 0: total += 1\n`, 5, locals), [['j+1', 4, true]]);
  });

  it('truth: comparison chains over ints and len(), not and parentheses; anything else is unknown', () => {
    const g = { ints: new Map([['j', 3], ['n', 4], ['i', 2]]), lenOf: (name: string) => (name === 's' ? 3 : undefined) };
    assert.equal(truth('j < n - 1', g), false);
    assert.equal(truth('0 <= j < n', g), true);
    assert.equal(truth('not (i >= len(s))', g), true);
    assert.equal(truth('i < len(t)', g), undefined);
    assert.equal(truth('x in seen', g), undefined);
    assert.equal(truth('nums[j] > 0', g), undefined);
  });

  it('a long row of cells is drawn in pages around its pointers, never shrunk (item 12)', () => {
    assert.deepEqual(arrayView.visibleSpans(30, [5]), [[0, 30]]);
    assert.deepEqual(arrayView.visibleSpans(200, [150, 151]), [[140, 180]]);
    // The row stays put while j walks through it.
    assert.deepEqual(arrayView.visibleSpans(200, [160, 161]), [[140, 180]]);
    assert.deepEqual(arrayView.visibleSpans(200, [5]), [[0, 40]]);
    assert.deepEqual(arrayView.visibleSpans(200, []), [[0, 40]]);
    const spread = arrayView.visibleSpans(512, [0, 255, 511]);
    assert.ok(spread.reduce((t, [a, b]) => t + b - a, 0) <= 40);
    for (const p of [0, 255, 511]) assert.ok(spread.some(([a, b]) => p >= a && p < b), `${p} in ${JSON.stringify(spread)}`);

    const items = Array.from({ length: 512 }, (_, i) => i);
    const svg = arrayView.renderArray({ name: 'arr', items, total: 700, pointers: [{ name: 'j', index: 300 }, { name: 'k', index: 650 }], mode: 'cells' });
    assert.ok(byClass(svg, 'cellbox').length <= 64);
    assert.ok(Number(svg.getAttribute('width')) <= 1100, `width ${svg.getAttribute('width')}`);
    const t = texts(svg);
    assert.ok(t.includes('… 290 …'), t.join(' | '));
    assert.ok(byClass(svg, 'index-text').some((e) => e.textContent === '290'), 'the page starts at 290');
    assert.ok(byClass(svg, 'cell-text').some((e) => e.textContent === '300'), 'values readable in the cells');
    // k is past the sent part: the last sent cells stand next to the note it points at.
    assert.ok(byClass(svg, 'cell-text').some((e) => e.textContent === '511'), t.join(' | '));
    assert.ok(t.includes('… 188 more not shown'), t.join(' | '));
    assert.ok(t.includes('k=650 (beyond the 512 shown)'));
  });

  it('a pointer only past the sent part draws the last sent page; len itself reads out of range (review V2 #2)', () => {
    // review progs/longptr.py: i = 560 on a 600-item list, 512 sent.
    const items = Array.from({ length: 512 }, (_, i) => i);
    const svg = arrayView.renderArray({ name: 'nums', items, total: 600, pointers: [{ name: 'i', index: 560 }], mode: 'cells' });
    const t = texts(svg);
    assert.ok(byClass(svg, 'cell-text').some((e) => e.textContent === '511'), t.join(' | '));
    assert.ok(!byClass(svg, 'cell-text').some((e) => e.textContent === '0'), 'not the first page');
    assert.ok(t.includes('… 88 more not shown'), t.join(' | '));
    assert.ok(t.includes('i=560 (beyond the 512 shown)'));
    // j == len(arr) on a line that reads arr[j]: the colour and the words agree.
    const oor = arrayView.renderArray({ name: 'arr', items, total: 700, pointers: [{ name: 'j', index: 700, outOfRange: true }], mode: 'cells' });
    const label = byClass(oor, 'ptr-text')[0];
    assert.equal(label.textContent, 'j=700 (out of range: len 700)');
    assert.ok(label.classes().includes('out-of-range'));
    assert.equal(arrayView.pointerText({ name: 'j', index: 4, outOfRange: true }, 4, 4), 'j=4 (out of range)');
  });

  it('long bars are squeezed into the usual width, and the subtitle says the list was cut', () => {
    const items = Array.from({ length: 200 }, (_, i) => 200 - i);
    const svg = arrayView.renderArray({ name: 'nums', items, total: 200, pointers: [{ name: 'j', index: 150 }], mode: 'bars' });
    assert.equal(byClass(svg, 'bar').length, 200);
    assert.ok(Number(svg.getAttribute('width')) <= 960, `width ${svg.getAttribute('width')}`);
    assert.ok(texts(svg).includes('j=150'));
    const root = draw([{ name: 'arr', value: ref(1), depth: 0 }], { 1: list(Array.from({ length: 512 }, (_, i) => i), 700) });
    assert.match(titles(root)[0], /len 700 \(first 512 shown\)/);
  });

  it("a learner's own def sum is tagged; the built-in re-bound is not (item 11)", () => {
    assert.equal(shadowsBuiltin('sum', { $t: 'fn', v: 'sum' }, 'function'), true);
    assert.equal(shadowsBuiltin('max', { $t: 'fn', v: 'max' }, 'builtin_function_or_method'), false);
    assert.equal(shadowsBuiltin('list', { $t: 'cls', v: 'list' }, 'type'), false);
    assert.equal(shadowsBuiltin('id', 7, 'int'), true);
  });

  it('Counter, OrderedDict and defaultdict previews name their type', () => {
    assert.equal(fmtPreview('dict', ['a', 'b'], 2, [2, 1], 'collections.Counter'), "Counter({'a': 2, 'b': 1})");
    assert.equal(fmtPreview('dict', [], 0, [], 'collections.Counter'), 'Counter()');
    assert.equal(fmtPreview('dict', ['x'], 1, [1], 'collections.OrderedDict'), "OrderedDict({'x': 1})");
    assert.equal(fmtPreview('dict', ['u'], 1, undefined, 'collections.defaultdict'), "defaultdict(…, {'u': …})");
  });

  it('a long dict: the cut in the subtitle, first and last rows, the row the step changed', () => {
    const entries = (bump: number): [Encoded, Encoded][] => Array.from({ length: 512 }, (_, i) => [i, i === 300 ? bump : i * i]);
    const now: Heap = { 1: { kind: 'dict', entries: entries(-1), len: 600 } };
    const before: Heap = { 1: { kind: 'dict', entries: entries(300 * 300), len: 600 } };
    const root = structures.renderStructures([{ name: 'memo', value: ref(1), depth: 0 }], now, before, { modes: new Map() }, () => undefined);
    assert.match(titles(root)[0], /dict · 600 keys \(first 512 shown\)/);
    const rows = all(root, (e) => e.nodeName === 'tr');
    assert.ok(rows.length <= 40, `${rows.length} rows`);
    const cells = rows.map((r) => r.textContent);
    assert.ok(cells.includes('300-1'), 'the changed row');
    assert.ok(cells.includes('… 288 keys …') && cells.includes('… 207 keys …'), cells.filter((c) => c.startsWith('…')).join(' | '));
    assert.equal(cells[cells.length - 1], '… 88 more keys not shown');
  });

  it('a wrapper holding two lists draws both, without a red note (Merger.l1, Merger.l2)', () => {
    const heap = heapOf({
      1: obj('Merger', { l1: ref(2), l2: ref(4) }),
      2: obj('Node', { val: 1, next: ref(3) }),
      3: obj('Node', { val: 3, next: null }),
      4: obj('Node', { val: 2, next: ref(5) }),
      5: obj('Node', { val: 4, next: null }),
    });
    const root = draw([{ name: 'm', value: ref(1), depth: 0 }], heap);
    assert.deepEqual(titles(root).map((t) => t.split(' ')[0].replace(/linked$/, '')), ['m.l1', 'm.l2']);
    assert.equal(byClass(root, 'hot-note').length, 0);
  });

  it('tree wrapper labels (bst.root) use the plain label colour', () => {
    const heap = heapOf({ 1: obj('BST', { root: ref(2) }), 2: obj('TreeNode', { val: 5, left: null, right: null }) });
    const root = draw([{ name: 'bst', value: ref(1), depth: 0 }], heap);
    const label = byClass(root, 'ptr-text').find((t) => t.textContent === 'bst.root');
    assert.ok(label?.classes().includes('field-label'), label?.getAttribute('class') ?? 'no label');
  });
});
